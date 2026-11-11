import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Alex, 11 Nov 2026: "it should be so easy to do anything, from signup, top-up, create workflows".
// An agent that signed up or logged in through the local server's account tools got a token back
// and was then unauthenticated on its very next call, because the server forgot the sign-in. It
// now keeps it (src/account-session.ts): same credentials file as the device-code sign-in,
// refreshed before it expires, refresh token never handed to the model.

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;
delete process.env.MCP_DEFAULT_ORG;
delete process.env.MCP_DEFAULT_APP;

const { createServer } = await import("../dist/index.js");
const { loadCredentials, saveCredentials, DeviceLoginError } = await import("../dist/device-login.js");
const { accountSessionToken, forgetAccountSession, keepAccountSession, keepSignIn, localSignInToken, signedInAnswer } = await import(
  "../dist/account-session.js"
);
const { runLoginCli } = await import("../dist/login-cli.js");

const AUTH = "https://apx.didit.me/auth/v2";
const CONSOLE = "https://business.didit.me";
const CLIENT = "client-of-the-users-application";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A token shaped like the auth service's: a JWT whose payload names the client it was issued to. */
function jwt(label, claims = { client_id: CLIENT }) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ ...claims, label })}.signature-${label}`;
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "didit-as-")), "cfg", "mcp-credentials.json");
}

/** Injected clock and fetch, as in device-login.test.mjs. */
function harness(routes = {}) {
  const state = { t: 5_000_000, calls: [] };
  const deps = {
    now: () => state.t,
    sleep: async (ms) => {
      state.t += ms;
    },
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      state.calls.push({ url: String(url), method: init.method || "GET", body });
      const handler = routes[String(url)];
      if (!handler) return json({ detail: "nope" }, 404);
      return typeof handler === "function" ? handler(body, state) : handler.clone();
    },
  };
  return { deps, state };
}

const signIn = (label = "first", lifetime = 3600) => ({
  access_token: jwt(label),
  refresh_token: `refresh-${label}`,
  expires_in: lifetime,
  token_type: "Bearer",
});

// ── Keeping the sign-in ─────────────────────────────────────────────────────

test("a sign-in is kept under the auth service's address, in a file only the person can read", () => {
  const file = tmpFile();
  const { deps, state } = harness();
  const kept = keepAccountSession(signIn(), deps, AUTH, file);
  assert.deepEqual(kept, { where: "file", path: file });
  const stored = loadCredentials(AUTH, file);
  assert.equal(stored.client_id, CLIENT);
  assert.equal(stored.access_token, jwt("first"));
  assert.equal(stored.refresh_token, "refresh-first");
  assert.equal(stored.expires_at, state.t + 3600_000);
  assert.equal(stored.signed_in_at, state.t);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  // A device-code sign-in lives under the console's address and is untouched.
  assert.equal(loadCredentials(CONSOLE, file), undefined);
});

test("an answer without an access token keeps nothing (second factor step, SSO notice)", () => {
  const file = tmpFile();
  const { deps } = harness();
  for (const answer of [{ "2fa_required": true, temp_token: "t" }, { sso_required: true }, null, "text"]) {
    assert.equal(keepAccountSession(answer, deps, AUTH, file), undefined);
  }
  assert.equal(fs.existsSync(file), false);
});

test("the client is read from the token's aud when it has no client_id claim", () => {
  const file = tmpFile();
  const { deps } = harness();
  keepAccountSession({ access_token: jwt("aud", { aud: "aud-client" }), refresh_token: "r" }, deps, AUTH, file);
  assert.equal(loadCredentials(AUTH, file).client_id, "aud-client");
});

test("the answer the model sees has no refresh token and says the server is signed in", () => {
  const answer = { ...signIn(), message: "Login successful", organization: { uuid: "o" } };
  const shown = signedInAnswer(answer, { where: "file", path: "/home/u/.config/didit/mcp-credentials.json" });
  assert.equal(shown.refresh_token, undefined);
  assert.equal(shown.access_token, answer.access_token);
  assert.equal(shown.signed_in, true);
  assert.deepEqual(shown.organization, { uuid: "o" });
  assert.match(shown.next_step, /the tools that follow are authenticated: do not pass access_token/);
  assert.match(shown.next_step, /mcp-credentials\.json/);
  assert.match(signedInAnswer(answer, { where: "memory" }).next_step, /keeps this sign-in in memory/);
  // Nothing was kept: the answer is returned exactly as it came.
  const stepUp = { "2fa_required": true, temp_token: "t" };
  assert.equal(signedInAnswer(stepUp, undefined), stepUp);
});

// ── Using and refreshing it ─────────────────────────────────────────────────

test("a fresh token is used without any request", async () => {
  const file = tmpFile();
  const { deps, state } = harness();
  keepAccountSession(signIn(), deps, AUTH, file);
  assert.equal(await accountSessionToken(deps, AUTH, file), jwt("first"));
  assert.equal(state.calls.length, 0);
  assert.equal(await accountSessionToken(deps, AUTH, tmpFile()), undefined);
});

test("a token that expires within 60 s is refreshed at the auth service and the rotated pair is stored", async () => {
  const file = tmpFile();
  const { deps, state } = harness({ [`${AUTH}/token/`]: json(signIn("second", 7200)) });
  keepAccountSession(signIn("first", 3600), deps, AUTH, file);
  const signedInAt = state.t;
  state.t += 3600_000 - 30_000;
  assert.equal(await accountSessionToken(deps, AUTH, file), jwt("second"));
  assert.deepEqual(state.calls, [
    { url: `${AUTH}/token/`, method: "POST", body: { grant_type: "refresh_token", refresh_token: "refresh-first", client_id: CLIENT } },
  ]);
  const stored = loadCredentials(AUTH, file);
  assert.equal(stored.refresh_token, "refresh-second");
  assert.equal(stored.expires_at, state.t + 7200_000);
  // A refresh is not a new sign-in: which sign-in is newer must not change.
  assert.equal(stored.signed_in_at, signedInAt);
});

test("concurrent callers share one refresh (a refresh token works once)", async () => {
  const file = tmpFile();
  const { deps, state } = harness({ [`${AUTH}/token/`]: () => json(signIn("second")) });
  keepAccountSession(signIn("first", 30), deps, AUTH, file);
  const tokens = await Promise.all([1, 2, 3].map(() => accountSessionToken(deps, AUTH, file)));
  assert.deepEqual(tokens, [jwt("second"), jwt("second"), jwt("second")]);
  assert.equal(state.calls.length, 1);
});

test("a session the auth service ended is removed and asks for a new sign-in", async () => {
  for (const status of [400, 401, 403]) {
    const file = tmpFile();
    const { deps } = harness({ [`${AUTH}/token/`]: json({ detail: "Refresh token invalid or expired" }, status) });
    keepAccountSession(signIn("first", 30), deps, AUTH, file);
    await assert.rejects(accountSessionToken(deps, AUTH, file), (error) => {
      assert.ok(error instanceof DeviceLoginError);
      assert.equal(error.code, "login_required");
      assert.match(error.message, /didit_account_login/);
      assert.ok(!error.message.includes("refresh-first"));
      return true;
    });
    assert.equal(loadCredentials(AUTH, file), undefined);
  }
});

test("an outage keeps the session, and a token that still works is used", async () => {
  const file = tmpFile();
  const down = harness({ [`${AUTH}/token/`]: json({}, 503) });
  keepAccountSession(signIn("first", 30), down.deps, AUTH, file);
  assert.equal(await accountSessionToken(down.deps, AUTH, file), jwt("first"));
  assert.equal(loadCredentials(AUTH, file).refresh_token, "refresh-first");

  const offline = harness();
  offline.deps.fetch = async () => {
    throw new Error("ECONNRESET");
  };
  keepAccountSession(signIn("first", 30), offline.deps, AUTH, file);
  assert.equal(await accountSessionToken(offline.deps, AUTH, file), jwt("first"));
  // Once the token itself has expired there is nothing usable: the outage is reported.
  offline.state.t += 60_000;
  await assert.rejects(accountSessionToken(offline.deps, AUTH, file), /Could not reach Didit/);
  assert.equal(loadCredentials(AUTH, file).refresh_token, "refresh-first");
});

test("a token with no refresh token works until it expires, then asks for a new sign-in", async () => {
  const file = tmpFile();
  const { deps, state } = harness();
  keepAccountSession({ access_token: jwt("only"), expires_in: 600 }, deps, AUTH, file);
  assert.equal(await accountSessionToken(deps, AUTH, file), jwt("only"));
  state.t += 600_000;
  await assert.rejects(accountSessionToken(deps, AUTH, file), /Sign in again/);
  assert.equal(state.calls.length, 0);
});

test("a home directory that cannot be written keeps the sign-in in memory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "didit-ro-"));
  // The credentials directory cannot be created: its parent is a file.
  const blocker = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocker, "x");
  const file = path.join(blocker, "cfg", "mcp-credentials.json");
  const { deps } = harness();
  try {
    assert.deepEqual(keepAccountSession(signIn("memory"), deps, AUTH, file), { where: "memory" });
    assert.equal(await accountSessionToken(deps, AUTH, file), jwt("memory"));
    assert.equal(forgetAccountSession(AUTH, file), true);
    assert.equal(await accountSessionToken(deps, AUTH, file), undefined);
  } finally {
    forgetAccountSession(AUTH, file);
  }
});

test("a file that turned read-only never brings the previous account back", { skip: process.getuid?.() === 0 }, async () => {
  // The file holds an earlier sign-in and can no longer be written (a read-only mount, a changed
  // owner). A new login is kept in memory and must win: reading the file first would keep the
  // server acting as the account that was signed in before.
  const file = tmpFile();
  const { deps, state } = harness({ [`${AUTH}/token/`]: json({ detail: "Refresh token invalid or expired" }, 401) });
  keepAccountSession(signIn("previous-account"), deps, AUTH, file);
  const directory = path.dirname(file);
  fs.chmodSync(directory, 0o500);
  try {
    assert.deepEqual(keepAccountSession(signIn("new-account", 600), deps, AUTH, file), { where: "memory" });
    assert.equal(loadCredentials(AUTH, file).access_token, jwt("previous-account"), "the file could not be changed");
    assert.equal(await accountSessionToken(deps, AUTH, file), jwt("new-account"));
    assert.equal(await localSignInToken(deps, CONSOLE, AUTH, file), jwt("new-account"));

    // The new session ends (its refresh is refused). The file still cannot be changed, and the
    // account in it must not come back.
    state.t += 600_000;
    await assert.rejects(accountSessionToken(deps, AUTH, file), /Sign in again/);
    assert.equal(await accountSessionToken(deps, AUTH, file), undefined);
    assert.equal(await localSignInToken(deps, CONSOLE, AUTH, file), undefined);
    assert.equal(forgetAccountSession(AUTH, file), false, "nothing is signed in any more");
  } finally {
    fs.chmodSync(directory, 0o700);
  }
  // Writable again: the next sign-in goes to the file and the memory entry is gone.
  assert.deepEqual(keepAccountSession(signIn("third"), deps, AUTH, file), { where: "file", path: file });
  assert.equal(await accountSessionToken(deps, AUTH, file), jwt("third"));
  assert.equal(loadCredentials(AUTH, file).access_token, jwt("third"));
});

test("a sign-in held in memory belongs to its own credentials file and auth address", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "didit-scope-"));
  const blocker = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocker, "x");
  const unwritable = path.join(blocker, "cfg", "mcp-credentials.json");
  const { deps } = harness();
  try {
    assert.deepEqual(keepAccountSession(signIn("memory"), deps, AUTH, unwritable), { where: "memory" });
    assert.equal(await accountSessionToken(deps, AUTH, tmpFile()), undefined, "another credentials file");
    assert.equal(await accountSessionToken(deps, "https://apx.staging.didit.me/auth/v2", unwritable), undefined, "another environment");
    assert.equal(await accountSessionToken(deps, AUTH, unwritable), jwt("memory"));
  } finally {
    forgetAccountSession(AUTH, unwritable);
  }
});

// ── Two sign-ins on one machine ─────────────────────────────────────────────

const device = (over = {}) => ({
  client_id: "device-client",
  access_token: "device.access.token",
  refresh_token: "device-refresh",
  expires_at: 9_000_000_000,
  ...over,
});

test("the local server uses whichever sign-in is newer", async () => {
  const file = tmpFile();
  const { deps, state } = harness();
  // A device-code sign-in from before sign-ins were dated counts as the older one.
  saveCredentials(CONSOLE, device(), file);
  assert.equal(await localSignInToken(deps, CONSOLE, AUTH, file), "device.access.token");
  keepAccountSession(signIn("account"), deps, AUTH, file);
  assert.equal(await localSignInToken(deps, CONSOLE, AUTH, file), jwt("account"));
  // A later device-code sign-in takes over again.
  saveCredentials(CONSOLE, device({ signed_in_at: state.t + 1 }), file);
  assert.equal(await localSignInToken(deps, CONSOLE, AUTH, file), "device.access.token");
  // Both are still stored: neither sign-in overwrote the other.
  assert.equal(loadCredentials(AUTH, file).refresh_token, "refresh-account");
  assert.equal(loadCredentials(CONSOLE, file).refresh_token, "device-refresh");
});

test("a remembered device client with no tokens is not a sign-in", async () => {
  const file = tmpFile();
  const { deps } = harness();
  saveCredentials(CONSOLE, { client_id: "device-client" }, file);
  assert.equal(await localSignInToken(deps, CONSOLE, AUTH, file), undefined);
  keepAccountSession(signIn("account"), deps, AUTH, file);
  assert.equal(await localSignInToken(deps, CONSOLE, AUTH, file), jwt("account"));
});

test("when the newer sign-in is over, the older one is used", async () => {
  const file = tmpFile();
  const { deps } = harness({ [`${AUTH}/token/`]: json({ detail: "Refresh token invalid or expired" }, 401) });
  saveCredentials(CONSOLE, device(), file);
  keepAccountSession(signIn("account", 30), deps, AUTH, file);
  assert.equal(await localSignInToken(deps, CONSOLE, AUTH, file), "device.access.token");
  assert.equal(loadCredentials(AUTH, file), undefined);
});

// ── Through the server ──────────────────────────────────────────────────────

/** A local (stdio) server whose backend is `backend(url, init)`; returns every request it sent. */
async function withLocalServer(backend, fn, options = {}) {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    return backend(String(url), init);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  const client = new Client({ name: "account-session-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client, seen);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = realFetch;
  }
}

const parsed = (result) => JSON.parse(result.content[0].text);

async function withCredentialsFile(fn) {
  const file = tmpFile();
  process.env.DIDIT_MCP_CREDENTIALS_FILE = file;
  try {
    return await fn(file);
  } finally {
    delete process.env.DIDIT_MCP_CREDENTIALS_FILE;
  }
}

const ORG = "69f2b990-24e3-4892-bbe7-1a6a628943b3";
const LIVE = "5bfe5319-625d-487c-a9c3-8f3cf50750b8";
const SANDBOX = "11111111-2222-4333-8444-555555555555";

/** The auth service and the API of a freshly created account. */
function newAccountBackend(url) {
  if (url === `${AUTH}/programmatic/verify-email/`) {
    return json({
      ...signIn("signup"),
      organization: { uuid: ORG, name: "acme" },
      application: { uuid: LIVE, name: "acme", client_id: "c-live", api_key: "sk_live_key", mode: "live" },
      sandbox_application: { uuid: SANDBOX, name: "acme (Sandbox)", client_id: "c-test", api_key: "sk_test_key", mode: "sandbox" },
    });
  }
  if (url === `${AUTH}/programmatic/login/`) return json({ ...signIn("login"), message: "Login successful" });
  if (url === `${AUTH}/2fa/verify/`) return json(signIn("second-factor"));
  // The two lists are read with a page size (paging.ts): match the path, whatever the query.
  const path = url.split("?")[0];
  if (path === `${AUTH}/organizations/me/`) return json([{ uuid: ORG, name: "acme" }]);
  if (path === `${AUTH}/organizations/me/${ORG}/applications/`) {
    return json([
      { uuid: LIVE, name: "acme", mode: "live" },
      { uuid: SANDBOX, name: "acme (Sandbox)", mode: "sandbox" },
    ]);
  }
  return json({ results: [] });
}

test("sign up, then use the account in the same conversation: no token is passed by the model", async () => {
  await withCredentialsFile(async (file) => {
    await withLocalServer(newAccountBackend, async (client, seen) => {
      const verified = parsed(await client.callTool({ name: "didit_account_verify_email", arguments: { email: "dev@acme.test", code: "A1B2C3" } }));
      assert.equal(verified.signed_in, true);
      assert.equal(verified.refresh_token, undefined);
      assert.equal(verified.sandbox_application.api_key, "sk_test_key");
      assert.equal(loadCredentials(AUTH, file).refresh_token, "refresh-signup");

      const context = parsed(await client.callTool({ name: "didit_context_get", arguments: {} }));
      assert.equal(context.application_count, 2);
      const workflows = await client.callTool({ name: "didit_workflow_list", arguments: { application_id: SANDBOX } });
      assert.notEqual(workflows.isError, true, workflows.content[0].text);

      const afterSignIn = seen.filter((request) => !request.url.endsWith("/programmatic/verify-email/"));
      assert.ok(afterSignIn.length >= 3);
      for (const request of afterSignIn) {
        assert.equal(request.headers.Authorization, `Bearer ${jwt("signup")}`, request.url);
      }
      assert.ok(afterSignIn.some((request) => request.url.includes(`/organization/${ORG}/application/${SANDBOX}/`)));
    });
  });
});

test("didit_account_login and didit_account_verify_2fa sign the local server in too", async () => {
  await withCredentialsFile(async (file) => {
    await withLocalServer(newAccountBackend, async (client, seen) => {
      const login = parsed(await client.callTool({ name: "didit_account_login", arguments: { email: "dev@acme.test", password: "pw" } }));
      assert.equal(login.signed_in, true);
      assert.equal(login.refresh_token, undefined);
      assert.equal(loadCredentials(AUTH, file).access_token, jwt("login"));

      const second = parsed(await client.callTool({ name: "didit_account_verify_2fa", arguments: { temp_token: "t", code: "123456" } }));
      assert.equal(second.signed_in, true);
      assert.equal(loadCredentials(AUTH, file).access_token, jwt("second-factor"));

      await client.callTool({ name: "didit_org_list", arguments: {} });
      assert.equal(seen.at(-1).headers.Authorization, `Bearer ${jwt("second-factor")}`);
    });
  });
});

test("a login that needs a second factor keeps nothing until it is finished", async () => {
  await withCredentialsFile(async (file) => {
    const backend = (url) =>
      url === `${AUTH}/programmatic/login/`
        ? json({ "2fa_required": true, temp_token: "temp", has_authenticator: true, has_passkeys: false })
        : json({});
    await withLocalServer(backend, async (client) => {
      const login = parsed(await client.callTool({ name: "didit_account_login", arguments: { email: "dev@acme.test", password: "pw" } }));
      assert.equal(login["2fa_required"], true);
      assert.equal(login.signed_in, undefined);
      assert.equal(fs.existsSync(file), false);
    });
  });
});

test("DIDIT_ACCESS_TOKEN still wins over a kept sign-in", async () => {
  await withCredentialsFile(async (file) => {
    keepAccountSession(signIn("kept"), undefined, AUTH, file);
    process.env.DIDIT_ACCESS_TOKEN = "env.access.token";
    try {
      await withLocalServer(newAccountBackend, async (client, seen) => {
        await client.callTool({ name: "didit_org_list", arguments: {} });
        assert.equal(seen.at(-1).headers.Authorization, "Bearer env.access.token");
      });
    } finally {
      delete process.env.DIDIT_ACCESS_TOKEN;
    }
  });
});

test("a hosted server never reads the credentials file", async () => {
  await withCredentialsFile(async (file) => {
    keepAccountSession(signIn("kept"), undefined, AUTH, file);
    await withLocalServer(
      newAccountBackend,
      async (client, seen) => {
        await client.callTool({ name: "didit_org_list", arguments: {} });
        assert.ok(seen.every((request) => request.headers.Authorization === undefined));
      },
      { hosted: true },
    );
  });
});

test("a hosted server keeps nothing: the account tools are refused there and no file is written", async () => {
  await withCredentialsFile(async (file) => {
    await withLocalServer(
      newAccountBackend,
      async (client, seen) => {
        for (const [name, args] of [
          ["didit_account_login", { email: "dev@acme.test", password: "pw" }],
          ["didit_account_verify_email", { email: "dev@acme.test", code: "A1B2C3" }],
          ["didit_account_verify_2fa", { temp_token: "t", code: "123456" }],
        ]) {
          const refused = await client.callTool({ name, arguments: args });
          assert.equal(refused.isError, true, name);
        }
        assert.equal(seen.length, 0, "a hosted server must not even call the auth service for these");
        assert.equal(fs.existsSync(file), false);
        assert.equal(await accountSessionToken(undefined, AUTH, file), undefined, "nothing in memory either");
      },
      { hosted: true },
    );
  });
});

test("the function that stores a sign-in is itself gated on the local server", async () => {
  // The refusal above is one guard. The store has its own, so it holds if that refusal ever moves.
  const file = tmpFile();
  const { deps } = harness();
  const answer = signIn("remote-caller");
  const untouched = keepSignIn(answer, { hosted: true }, deps, AUTH, file);
  assert.equal(untouched, answer, "a hosted server returns the answer exactly as it came");
  assert.equal(fs.existsSync(file), false);
  assert.equal(await accountSessionToken(deps, AUTH, file), undefined, "nothing in memory either");

  const local = keepSignIn(answer, { hosted: false }, deps, AUTH, file);
  assert.equal(local.signed_in, true);
  assert.equal(local.refresh_token, undefined);
  assert.equal(loadCredentials(AUTH, file).refresh_token, "refresh-remote-caller");
});

test("the tools say the server is signed in and no longer promise a refresh token", async () => {
  await withLocalServer(newAccountBackend, async (client) => {
    const { tools } = await client.listTools();
    const description = (name) => tools.find((tool) => tool.name === name).description;
    for (const name of ["didit_account_verify_email", "didit_account_login", "didit_account_verify_2fa"]) {
      assert.match(description(name), /[Ss]igns the local server in/, name);
      assert.doesNotMatch(description(name), /refresh_token/, name);
    }
    assert.match(description("didit_org_list"), /the sign-in from login\/verify_email is used automatically/);
  });
});

test("logout removes the kept sign-in from this machine and never prints a token", async () => {
  await withCredentialsFile(async (file) => {
    keepAccountSession(signIn("kept"), undefined, AUTH, file);
    const lines = [];
    const { deps } = harness();
    assert.equal(await runLoginCli("logout", deps, (line) => lines.push(line), CONSOLE), 0);
    assert.match(lines.join("\n"), /The sign-in kept from didit_account_login was removed/);
    assert.equal(loadCredentials(AUTH, file), undefined);
    assert.ok(!lines.join("\n").includes("refresh-kept"));
    assert.ok(!lines.join("\n").includes(jwt("kept")));

    const nothing = [];
    assert.equal(await runLoginCli("logout", deps, (line) => nothing.push(line), CONSOLE), 0);
    assert.match(nothing.join("\n"), /No Didit credentials are stored/);
  });
});
