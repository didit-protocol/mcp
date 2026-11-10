import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DEVICE_GRANT_TYPE,
  DeviceLoginError,
  getStoredAccessToken,
  loadCredentials,
  logout,
  pollDeviceLogin,
  saveCredentials,
  startDeviceLogin,
} from "../dist/device-login.js";
import { runLoginCli } from "../dist/login-cli.js";
import { createServer } from "../dist/index.js";

delete process.env.DIDIT_ACCESS_TOKEN;
const ORIGIN = "https://business.didit.me";
const STAGING = "https://business.staging.didit.me";
const SECRET_ACCESS = "access-SECRET-1";
const SECRET_REFRESH = "refresh-SECRET-1";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "didit-dl-"));
  return path.join(dir, "cfg", "mcp-credentials.json");
}

// Fake clock: sleeping advances time, so interval assertions are exact and instant.
function harness(routes) {
  const state = { t: 1_000_000, calls: [], sleeps: [] };
  const deps = {
    now: () => state.t,
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.t += ms;
    },
    fetch: async (url, init = {}) => {
      const u = String(url);
      const isJson = init.headers?.["Content-Type"] === "application/json";
      const body = init.body ? (isJson ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : undefined;
      state.calls.push({ url: u, at: state.t, body, method: init.method || "GET" });
      const handler = routes[u];
      if (!handler) return json({ detail: "nope" }, 404);
      return typeof handler === "function" ? handler(body, state) : handler.clone();
    },
  };
  return { deps, state };
}

const EP = {
  device: `${ORIGIN}/api/auth/oauth-device-authorization`,
  token: `${ORIGIN}/api/auth/oauth-token`,
  register: `${ORIGIN}/api/auth/oauth-register`,
  revoke: `${ORIGIN}/api/auth/oauth-revoke`,
  disco: `${ORIGIN}/.well-known/oauth-authorization-server`,
};
const deviceBody = {
  device_code: "DEVICE-SECRET",
  user_code: "WDJB-MJHT",
  verification_uri: `${ORIGIN}/device`,
  verification_uri_complete: `${ORIGIN}/device?user_code=WDJB-MJHT`,
  expires_in: 600,
  interval: 5,
};
const tokens = { access_token: SECRET_ACCESS, refresh_token: SECRET_REFRESH, token_type: "Bearer", expires_in: 3600, scope: "openid didit:management" };
const baseRoutes = (over = {}) => ({
  [EP.disco]: json({ device_authorization_endpoint: EP.device, token_endpoint: EP.token, registration_endpoint: EP.register, revocation_endpoint: EP.revoke }),
  [EP.register]: json({ client_id: "client-1" }, 201),
  [EP.device]: json(deviceBody),
  ...over,
});

test("discovery failure falls back to the documented endpoint paths", async () => {
  const file = tmpFile();
  const { deps, state } = harness({ [EP.disco]: json({}, 500), [EP.register]: json({ client_id: "c" }, 201), [EP.device]: json(deviceBody) });
  const p = await startDeviceLogin(deps, ORIGIN, file);
  assert.equal(p.endpoints.token_endpoint, EP.token);
  assert.ok(state.calls.some((c) => c.url === EP.register));
  assert.ok(state.calls.some((c) => c.url === EP.device));
});

test("discovery endpoints win over the fallback paths", async () => {
  const file = tmpFile();
  const custom = `${ORIGIN}/custom/device`;
  const { deps, state } = harness(baseRoutes({ [EP.disco]: json({ device_authorization_endpoint: custom }), [custom]: json(deviceBody) }));
  await startDeviceLogin(deps, ORIGIN, file);
  assert.ok(state.calls.some((c) => c.url === custom));
});

test("registration is a public device-grant client with no redirect_uris, then cached", async () => {
  const file = tmpFile();
  const { deps, state } = harness(baseRoutes());
  await startDeviceLogin(deps, ORIGIN, file);
  const reg = state.calls.find((c) => c.url === EP.register);
  assert.deepEqual(reg.body.grant_types, [DEVICE_GRANT_TYPE, "refresh_token"]);
  assert.equal(reg.body.token_endpoint_auth_method, "none");
  assert.equal("redirect_uris" in reg.body, false);
  assert.equal(reg.body.client_name, "Didit MCP (terminal)");
  const dev = state.calls.find((c) => c.url === EP.device);
  assert.equal(dev.body.client_id, "client-1");
  assert.match(dev.body.scope, /didit:management/);
  assert.ok(dev.body.device_name.length > 0 && dev.body.device_name.length <= 64);
  await startDeviceLogin(deps, ORIGIN, file);
  assert.equal(state.calls.filter((c) => c.url === EP.register).length, 1);
});

test("a cached client the server forgot is registered again once", async () => {
  const file = tmpFile();
  saveCredentials(ORIGIN, { client_id: "stale" }, file);
  const { deps, state } = harness(
    baseRoutes({ [EP.device]: (body) => (body.client_id === "stale" ? json({ error: "invalid_client" }, 400) : json(deviceBody)) }),
  );
  const p = await startDeviceLogin(deps, ORIGIN, file);
  assert.equal(p.client_id, "client-1");
  assert.equal(state.calls.filter((c) => c.url === EP.register).length, 1);
});

test("authorization_pending keeps polling at the interval, then stores the tokens", async () => {
  const file = tmpFile();
  let n = 0;
  const { deps, state } = harness(baseRoutes({ [EP.token]: () => (++n < 3 ? json({ error: "authorization_pending" }, 400) : json(tokens)) }));
  const p = await startDeviceLogin(deps, ORIGIN, file);
  const res = await pollDeviceLogin(deps, p, { file });
  assert.equal(res.status, "connected");
  assert.equal(res.scope, "openid didit:management");
  const polls = state.calls.filter((c) => c.url === EP.token);
  assert.equal(polls.length, 3);
  assert.equal(polls[0].body.grant_type, DEVICE_GRANT_TYPE);
  for (let i = 1; i < polls.length; i++) assert.ok(polls[i].at - polls[i - 1].at >= 5000);
  assert.equal(loadCredentials(ORIGIN, file).refresh_token, SECRET_REFRESH);
});

test("slow_down adds 5 seconds to every later poll", async () => {
  const file = tmpFile();
  let n = 0;
  const { deps, state } = harness(
    baseRoutes({ [EP.token]: () => (++n === 1 ? json({ error: "slow_down" }, 400) : n < 4 ? json({ error: "authorization_pending" }, 400) : json(tokens)) }),
  );
  const p = await startDeviceLogin(deps, ORIGIN, file);
  await pollDeviceLogin(deps, p, { file });
  const polls = state.calls.filter((c) => c.url === EP.token);
  assert.equal(polls[1].at - polls[0].at, 10_000);
  assert.equal(polls[2].at - polls[1].at, 10_000);
  assert.equal(p.interval, 10);
});

test("expired_token and access_denied stop with distinct errors", async () => {
  for (const error of ["expired_token", "access_denied"]) {
    const file = tmpFile();
    const { deps, state } = harness(baseRoutes({ [EP.token]: json({ error }, 400) }));
    const p = await startDeviceLogin(deps, ORIGIN, file);
    await assert.rejects(pollDeviceLogin(deps, p, { file }), (e) => e instanceof DeviceLoginError && e.code === error);
    assert.equal(state.calls.filter((c) => c.url === EP.token).length, 1);
    assert.equal(loadCredentials(ORIGIN, file)?.refresh_token, undefined);
  }
});

test("polling stops at expires_in and returns pending when the deadline comes first", async () => {
  const file = tmpFile();
  const { deps } = harness(baseRoutes({ [EP.token]: json({ error: "authorization_pending" }, 400) }));
  const p = await startDeviceLogin(deps, ORIGIN, file);
  const soon = await pollDeviceLogin(deps, p, { file, deadline: deps.now() + 1000 });
  assert.equal(soon.status, "pending");
  await assert.rejects(pollDeviceLogin(deps, p, { file }), (e) => e.code === "expired_token");
});

test("credentials file is 0600 in a 0700 directory and keyed by origin", async () => {
  const file = tmpFile();
  saveCredentials(ORIGIN, { client_id: "a", refresh_token: "r1" }, file);
  saveCredentials(STAGING, { client_id: "b", refresh_token: "r2" }, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(raw.servers).sort(), [ORIGIN, STAGING].sort());
  assert.equal(loadCredentials(STAGING, file).client_id, "b");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["mcp-credentials.json"]);
});

const stored = (over = {}) => ({ client_id: "client-1", access_token: "old-access", refresh_token: "old-refresh", expires_at: 1_000_000 + 30_000, scope: "s", ...over });

test("a token that expires within 60s is refreshed and the rotated refresh token is stored", async () => {
  const file = tmpFile();
  saveCredentials(ORIGIN, stored(), file);
  const { deps, state } = harness(baseRoutes({ [EP.token]: json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }) }));
  assert.equal(await getStoredAccessToken(deps, ORIGIN, file), "new-access");
  const call = state.calls.find((c) => c.url === EP.token);
  assert.deepEqual(call.body, { grant_type: "refresh_token", refresh_token: "old-refresh", client_id: "client-1" });
  const after = loadCredentials(ORIGIN, file);
  assert.equal(after.refresh_token, "new-refresh");
  assert.equal(after.expires_at, 1_000_000 + 3_600_000);
});

test("a fresh token is used without any request", async () => {
  const file = tmpFile();
  saveCredentials(ORIGIN, stored({ expires_at: 1_000_000 + 600_000 }), file);
  const { deps, state } = harness(baseRoutes());
  assert.equal(await getStoredAccessToken(deps, ORIGIN, file), "old-access");
  assert.equal(state.calls.length, 0);
});

test("concurrent callers share one refresh", async () => {
  const file = tmpFile();
  saveCredentials(ORIGIN, stored(), file);
  const { deps, state } = harness(
    baseRoutes({
      [EP.token]: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      },
    }),
  );
  const results = await Promise.all([1, 2, 3, 4].map(() => getStoredAccessToken(deps, ORIGIN, file)));
  assert.deepEqual(results, Array(4).fill("new-access"));
  assert.equal(state.calls.filter((c) => c.url === EP.token).length, 1);
});

test("polling stops at the code's expiry instead of sleeping past it", async () => {
  const file = tmpFile();
  const { deps, state } = harness(baseRoutes({ [EP.token]: json({ error: "authorization_pending" }, 400) }));
  const pending = await startDeviceLogin(deps, ORIGIN, file);
  // Only 3 seconds left, and the next poll is due in 5.
  pending.expires_at = state.t + 3_000;
  await assert.rejects(pollDeviceLogin(deps, pending, { file }), (e) => e.code === "expired_token");
  assert.equal(state.calls.filter((c) => c.url === EP.token).length, 0);
  assert.equal(state.sleeps.length, 0);
});

test("a network failure during refresh keeps a still-valid token and the credentials", async () => {
  const file = tmpFile();
  // Inside the refresh window (expires in 30 s) but not expired yet.
  saveCredentials(ORIGIN, stored(), file);
  const { deps } = harness(
    baseRoutes({
      [EP.token]: () => {
        throw new TypeError("fetch failed");
      },
    }),
  );
  assert.equal(await getStoredAccessToken(deps, ORIGIN, file), "old-access");
  assert.equal(loadCredentials(ORIGIN, file).refresh_token, "old-refresh");
});

test("invalid_grant on refresh clears the credentials and asks for a new login", async () => {
  const file = tmpFile();
  saveCredentials(ORIGIN, stored(), file);
  const { deps } = harness(baseRoutes({ [EP.token]: json({ error: "invalid_grant" }, 400) }));
  await assert.rejects(getStoredAccessToken(deps, ORIGIN, file), (e) => e.code === "login_required" && /login/.test(e.message));
  assert.equal(loadCredentials(ORIGIN, file), undefined);
});

test("logout revokes the refresh token and deletes only this origin", async () => {
  const file = tmpFile();
  saveCredentials(ORIGIN, stored(), file);
  saveCredentials(STAGING, stored({ client_id: "stg" }), file);
  const { deps, state } = harness(baseRoutes({ [EP.revoke]: json({}) }));
  const res = await logout(deps, ORIGIN, file);
  assert.deepEqual(res, { hadCredentials: true, revoked: true });
  const revocation = state.calls.find((c) => c.url === EP.revoke).body;
  assert.equal(revocation.token, "old-refresh");
  assert.equal(revocation.token_type_hint, "refresh_token");
  // The authorization server only accepts a revocation from a client it registered.
  assert.equal(revocation.client_id, stored().client_id);
  assert.equal(loadCredentials(ORIGIN, file), undefined);
  assert.equal(loadCredentials(STAGING, file).client_id, "stg");
});

test("the login command never prints a token and exits non-zero on denial", async () => {
  const file = tmpFile();
  process.env.DIDIT_MCP_CREDENTIALS_FILE = file;
  try {
    const lines = [];
    const ok = harness(baseRoutes({ [EP.token]: json(tokens) }));
    assert.equal(await runLoginCli("login", ok.deps, (l) => lines.push(l), ORIGIN), 0);
    const text = lines.join("\n");
    assert.match(text, /To connect this machine to your Didit account, open https:\/\/business\.didit\.me\/device and enter the code WDJB-MJHT/);
    assert.match(text, /Or open: https:\/\/business\.didit\.me\/device\?user_code=WDJB-MJHT/);
    assert.match(text, /Approve only if the code on the page matches this one\./);
    assert.match(text, /Scopes granted: openid didit:management/);
    for (const secret of [SECRET_ACCESS, SECRET_REFRESH, "DEVICE-SECRET"]) assert.ok(!text.includes(secret));

    const denied = [];
    const bad = harness(baseRoutes({ [EP.token]: json({ error: "access_denied" }, 400) }));
    assert.equal(await runLoginCli("login", bad.deps, (l) => denied.push(l), ORIGIN), 1);
    assert.match(denied.join("\n"), /denied/);
    assert.ok(!denied.join("\n").includes("DEVICE-SECRET"));

    const out = [];
    const lo = harness(baseRoutes({ [EP.revoke]: json({}) }));
    assert.equal(await runLoginCli("logout", lo.deps, (l) => out.push(l), ORIGIN), 0);
    assert.ok(!out.join("\n").includes(SECRET_REFRESH));
  } finally {
    delete process.env.DIDIT_MCP_CREDENTIALS_FILE;
  }
});

const DEVICE_TOOLS = ["didit_account_device_login_start", "didit_account_device_login_poll"];

async function toolNames(opts) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(opts);
  await server.connect(st);
  const client = new Client({ name: "dl-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(ct);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

test("device login tools exist on stdio and never on a hosted server", async () => {
  const stdio = await toolNames({});
  const hosted = await toolNames({ hosted: true });
  for (const name of DEVICE_TOOLS) {
    assert.ok(stdio.includes(name), `${name} missing from stdio`);
    assert.ok(!hosted.includes(name), `${name} leaked into hosted`);
  }
});
