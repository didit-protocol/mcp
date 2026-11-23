import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredentials } from "../dist/device-login.js";
import { MCP_AUTHORIZATION_SERVER_ORIGIN } from "../dist/config.js";
import { apiKeyAuthInfo } from "../dist/api-key-connection.js";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ALL_TOOLSETS } from "../dist/toolsets.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";

// the tools that set Didit Authentication up by API, against the `API contract:` of
// service-didit-auth PR #1051. That contract is the route table below, plus the
// serializers' bodies:
//
//   GET   organizations/{org}/applications/{app}/authentication/                ConfigurationSerializer
//   PUT   …/authentication/methods/{name}/                                      MethodSerializer
//   GET   …/authentication/settings/                                            ProductSettingsSerializer
//   PATCH …/authentication/settings/
//   GET   …/authentication/onboarding/                                          OnboardingSerializer
//   PATCH …/authentication/onboarding/
//
// These tests stand in for service-didit-auth, so a tool only passes when its path, method and body
// match what that service accepts, and hold the rules the issue names: a read grant reads and
// cannot write, a provider secret is never echoed back, and a backend refusal is an error a model
// can act on rather than a success.

const AUTH = "https://apx.didit.me/auth/v2";
const ORG = "11111111-1111-1111-1111-111111111111";
const APP = "22222222-2222-2222-2222-222222222222";
const WORKFLOW = "33333333-3333-3333-3333-333333333333";
const BASE = `/organizations/${ORG}/applications/${APP}/authentication/`;
const SCOPE = { organization_id: ORG, application_id: APP };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Stands the auth service in for the length of one test; returns the requests it received. */
function stubAuth(reply = () => json({})) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const request = { method, path: pathname.replace(/^\/auth\/v2/, ""), body, url: String(url) };
    requests.push(request);
    return reply(request);
  };
  return requests;
}

const textOf = (result) => (result.content ?? []).map((block) => block.text ?? "").join("\n");

async function withClient(options, authInfo, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  }
  const client = new Client({ name: "authentication-tools-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const PERSON = { token: "authentication.person.token", clientId: "client", scopes: ["didit:management"], extra: { organization_id: ORG } };

const originalFetch = globalThis.fetch;

test("every setup step calls the route, method and body the service accepts", async () => {
  const requests = stubAuth(() => json({ ok: true }));
  try {
    await withClient({ hosted: true }, PERSON, async (client) => {
      const call = async (name, args) => {
        requests.length = 0;
        const result = await client.callTool({ name, arguments: { ...SCOPE, ...args } });
        assert.equal(result.isError, undefined, `${name}: ${textOf(result)}`);
        return requests.filter((request) => request.path.startsWith("/organizations/"));
      };

      assert.deepEqual(await call("didit_authentication_get", {}), [
        { method: "GET", path: BASE, body: undefined, url: `${AUTH}${BASE}` },
      ]);
      assert.deepEqual(await call("didit_authentication_method_set", { name: "code", enabled: true }), [
        { method: "PUT", path: `${BASE}methods/code/`, body: { enabled: true }, url: `${AUTH}${BASE}methods/code/` },
      ]);
      assert.deepEqual(
        await call("didit_authentication_method_set", {
          name: "google",
          enabled: true,
          client_id: "abc.apps.googleusercontent.com",
          client_secret: "provider-secret",
        }),
        [
          {
            method: "PUT",
            path: `${BASE}methods/google/`,
            body: { enabled: true, credentials: { client_id: "abc.apps.googleusercontent.com", client_secret: "provider-secret" } },
            url: `${AUTH}${BASE}methods/google/`,
          },
        ],
      );
      assert.deepEqual(await call("didit_authentication_method_set", { name: "google", enabled: true, credential_source: "didit_test" }), [
        { method: "PUT", path: `${BASE}methods/google/`, body: { enabled: true, credential_source: "didit_test" }, url: `${AUTH}${BASE}methods/google/` },
      ]);
      assert.deepEqual(await call("didit_authentication_method_set", { name: "phone", enabled: true, workflow_id: WORKFLOW }), [
        { method: "PUT", path: `${BASE}methods/phone/`, body: { enabled: true, workflow_id: WORKFLOW }, url: `${AUTH}${BASE}methods/phone/` },
      ]);
      assert.deepEqual(await call("didit_authentication_settings_get", {}), [
        { method: "GET", path: `${BASE}settings/`, body: undefined, url: `${AUTH}${BASE}settings/` },
      ]);
      // Only what the caller sent: the other settings keep their stored values.
      assert.deepEqual(await call("didit_authentication_settings_update", { sign_in_ui: "own", mfa_policy: "everyone" }), [
        { method: "PATCH", path: `${BASE}settings/`, body: { sign_in_ui: "own", mfa_policy: "everyone" }, url: `${AUTH}${BASE}settings/` },
      ]);
      assert.deepEqual(await call("didit_authentication_onboarding_get", {}), [
        { method: "GET", path: `${BASE}onboarding/`, body: undefined, url: `${AUTH}${BASE}onboarding/` },
      ]);
      assert.deepEqual(await call("didit_authentication_onboarding_update", { test_skipped: true }), [
        { method: "PATCH", path: `${BASE}onboarding/`, body: { test_skipped: true }, url: `${AUTH}${BASE}onboarding/` },
      ]);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("configuration read-back preserves disabled methods and credential sources", async (t) => {
  const methods = [
    { name: "code", enabled: true, credential_source: null },
    { name: "google", enabled: true, credential_source: "didit_test" },
    { name: "github", enabled: false, credential_source: "own" },
  ];
  t.after(() => { globalThis.fetch = originalFetch; });
  stubAuth(() => json({ methods }));
  await withClient({ hosted: true }, PERSON, async (client) => {
    const result = await client.callTool({ name: "didit_authentication_get", arguments: SCOPE });
    assert.equal(result.isError, undefined, textOf(result));
    assert.deepEqual(result.structuredContent.methods, methods);
  });
});

test("a provider secret never comes back in the tool result", async () => {
  const requests = stubAuth(({ method }) =>
    method === "PUT"
      ? json({
          name: "google",
          enabled: true,
          credential_source: "own",
          configured: true,
          client_id: "abc.apps.googleusercontent.com",
          client_secret: "provider-secret",
          encrypted_credentials: { sealed: "provider-secret" },
        })
      : json({}),
  );
  try {
    await withClient({ hosted: true }, PERSON, async (client) => {
      const result = await client.callTool({
        name: "didit_authentication_method_set",
        arguments: { ...SCOPE, name: "google", enabled: true, client_id: "abc.apps.googleusercontent.com", client_secret: "provider-secret" },
      });
      assert.equal(result.isError, undefined, textOf(result));
      assert.ok(!textOf(result).includes("provider-secret"), "the secret is not in the model-facing text");
      assert.ok(!JSON.stringify(result.structuredContent).includes("provider-secret"), "the secret is not in the structured result");
      const answer = result.structuredContent;
      assert.equal(answer.client_id, "abc.apps.googleusercontent.com", "the public client id stays readable");
      assert.equal(answer.credential_source, "own", "the credential source stays readable, the read-back depends on it");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reads need read:authentication and changes need write:authentication", async () => {
  assert.equal(TOOL_PERMISSIONS.didit_authentication_get, "read:authentication");
  assert.equal(TOOL_PERMISSIONS.didit_authentication_settings_get, "read:authentication");
  assert.equal(TOOL_PERMISSIONS.didit_authentication_onboarding_get, "read:authentication");
  assert.equal(TOOL_PERMISSIONS.didit_authentication_method_set, "write:authentication");
  assert.equal(TOOL_PERMISSIONS.didit_authentication_settings_update, "write:authentication");
  assert.equal(TOOL_PERMISSIONS.didit_authentication_onboarding_update, "write:authentication");

  const previous = process.env.MCP_PERMISSION_MODE;
  process.env.MCP_PERMISSION_MODE = "shadow";
  const requests = stubAuth(() => json({ ok: true }));
  try {
    // A read-only grant: the read-back runs, the change is refused before it leaves.
    const reader = { ...PERSON, scopes: ["didit:management", "read:authentication"] };
    await withClient({ hosted: true }, reader, async (client) => {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(listed.includes("didit_authentication_get"));
      assert.ok(!listed.includes("didit_authentication_settings_update"));
      const read = await client.callTool({ name: "didit_authentication_get", arguments: SCOPE });
      assert.equal(read.isError, undefined, textOf(read));

      requests.length = 0;
      const write = await client.callTool({ name: "didit_authentication_settings_update", arguments: { ...SCOPE, sign_in_ui: "own" } });
      assert.equal(write.isError, true);
      assert.match(textOf(write), /write:authentication/);
      assert.deepEqual(requests.filter((request) => request.method === "PATCH"), [], "nothing was sent");
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.MCP_PERMISSION_MODE;
    else process.env.MCP_PERMISSION_MODE = previous;
  }
});

test("a read-only connection lists the read-back and refuses every change", async () => {
  const selection = { toolsets: ALL_TOOLSETS, readOnly: true, unknown: [] };
  const requests = stubAuth(() => json({ ok: true }));
  try {
    await withClient({ hosted: true, selection }, PERSON, async (client) => {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(listed.includes("didit_authentication_get"));
      assert.ok(listed.includes("didit_authentication_settings_get"));
      assert.ok(!listed.includes("didit_authentication_method_set"));
      assert.ok(!listed.includes("didit_authentication_settings_update"));

      const write = await client.callTool({ name: "didit_authentication_method_set", arguments: { ...SCOPE, name: "code", enabled: true } });
      assert.equal(write.isError, true);
      assert.match(textOf(write), /read-only/);
      assert.deepEqual(requests.filter((request) => request.method === "PUT"), []);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a backend refusal is a tool error that says what it means", async () => {
  const cases = [
    { status: 400, body: { credential_source: "sandbox_only" }, expected: /sandbox_only/, hint: /sandbox application/ },
    { status: 400, body: { credential_source: "unavailable" }, expected: /unavailable/, hint: /client_id and client_secret/ },
    { status: 400, body: { credentials: "not_supported" }, expected: /not_supported/, hint: /only to google, microsoft, apple/ },
    { status: 400, body: { name: "method_unavailable" }, expected: /method_unavailable/, hint: /method name/ },
    { status: 400, body: { agent_humans_only: "passkey_required" }, expected: /passkey_required/, hint: /passkey enrolled/ },
    { status: 403, body: { detail: "owner_or_admin_required" }, expected: /owner_or_admin_required/, hint: /owner or admin/ },
    { status: 403, body: { detail: "You do not have permission to perform this action." }, expected: /forbidden/, hint: /didit:management/ },
  ];
  try {
    for (const { status, body, expected, hint } of cases) {
      stubAuth(() => json(body, status));
      await withClient({ hosted: true, liveAccess: async () => ({ permissions: ["write:authentication"] }) }, PERSON, async (client) => {
        const result = await client.callTool({
          name: "didit_authentication_method_set",
          arguments: { ...SCOPE, name: "google", enabled: true, credential_source: "didit_test" },
        });
        assert.equal(result.isError, true, `${status}: a refusal is never a success`);
        assert.match(textOf(result), expected);
        assert.match(textOf(result), hint);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Authentication turned off: every setup change says a person turns it on in the console", async () => {
  const writes = [
    { name: "didit_authentication_method_set", arguments: { ...SCOPE, name: "code", enabled: true } },
    { name: "didit_authentication_settings_update", arguments: { ...SCOPE, mfa_policy: "everyone" } },
    { name: "didit_authentication_onboarding_update", arguments: { ...SCOPE, sign_in_ui: "own" } },
  ];
  try {
    for (const call of writes) {
      stubAuth(() => json({ detail: "product_disabled" }, 409));
      await withClient({ hosted: true, liveAccess: async () => ({ permissions: ["write:authentication"] }) }, PERSON, async (client) => {
        const result = await client.callTool(call);
        assert.equal(result.isError, true, `${call.name}: a refusal is never a success`);
        assert.match(textOf(result), /product_disabled/);
        assert.match(textOf(result), /turns it on for the application in the console/);
        assert.doesNotMatch(textOf(result), /transaction monitoring/, `${call.name}: not the generic 409 hint`);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an incomplete or empty change is refused before it is sent", async () => {
  const requests = stubAuth(() => json({ ok: true }));
  try {
    await withClient({ hosted: true }, PERSON, async (client) => {
      const call = (name, args) => client.callTool({ name, arguments: { ...SCOPE, ...args } });

      const halfPair = await call("didit_authentication_method_set", { name: "google", enabled: true, client_id: "abc" });
      assert.equal(halfPair.isError, true);
      assert.match(textOf(halfPair), /client_id and client_secret are both required/);

      const noState = await call("didit_authentication_method_set", { name: "code" });
      assert.equal(noState.isError, true);
      assert.match(textOf(noState), /enabled is required/);

      const emptySettings = await call("didit_authentication_settings_update", {});
      assert.equal(emptySettings.isError, true);
      assert.match(textOf(emptySettings), /Nothing to update/);

      const emptyOnboarding = await call("didit_authentication_onboarding_update", {});
      assert.equal(emptyOnboarding.isError, true);
      assert.match(textOf(emptyOnboarding), /Nothing to update/);
    });
    assert.deepEqual(requests.filter((request) => request.path.startsWith("/organizations/")), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("role permissions alone cannot list or call setup tools", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = stubAuth();
  for (const scopes of [[], ["openid", "read:authentication", "write:authentication"]]) {
    await withClient({ hosted: true }, { ...PERSON, scopes }, async (client) => {
      const tools = (await client.listTools()).tools;
      assert.ok(!tools.some(({ name }) => name.startsWith("didit_authentication_")));
      for (const name of Object.keys(TOOL_PERMISSIONS).filter((tool) => tool.startsWith("didit_authentication_"))) {
        const result = await client.callTool({ name, arguments: SCOPE });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /didit:management/);
      }
    });
  }
  assert.deepEqual(requests, []);
});

test("provider validation failures cannot echo submitted secrets in error metadata", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  const secret = "rejected-secret";
  stubAuth(() => json({ detail: `Invalid client_secret: ${secret}`, code: secret, next_step: { description: secret } }, 400));
  await withClient({ hosted: true }, PERSON, async (client) => {
    const result = await client.callTool({
      name: "didit_authentication_method_set",
      arguments: { ...SCOPE, name: "google", enabled: true, client_id: "client", client_secret: secret },
    });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /rejected-secret/);
    assert.match(textOf(result), /bad_request/);
  });
});

test("local setup uses the scope and token of the device login", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "setup-login-"));
  const file = join(dir, "credentials.json");
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer device-token");
    return json({ methods: [] });
  });
  const oldFile = process.env.DIDIT_MCP_CREDENTIALS_FILE;
  const oldToken = process.env.DIDIT_ACCESS_TOKEN;
  process.env.DIDIT_MCP_CREDENTIALS_FILE = file;
  delete process.env.DIDIT_ACCESS_TOKEN;
  t.after(() => {
    if (oldFile === undefined) delete process.env.DIDIT_MCP_CREDENTIALS_FILE;
    else process.env.DIDIT_MCP_CREDENTIALS_FILE = oldFile;
    if (oldToken !== undefined) process.env.DIDIT_ACCESS_TOKEN = oldToken;
    rmSync(dir, { recursive: true, force: true });
  });
  for (const allowed of [false, true]) {
    saveCredentials(MCP_AUTHORIZATION_SERVER_ORIGIN, {
      client_id: "device-client", access_token: "device-token", refresh_token: "refresh",
      scope: allowed ? "openid didit:management" : "openid", expires_at: Date.now() + 3600000,
    }, file);
    await withClient({}, undefined, async (client) => {
      assert.equal((await client.listTools()).tools.some(({ name }) => name === "didit_authentication_get"), allowed);
      const result = await client.callTool({ name: "didit_authentication_get", arguments: SCOPE });
      assert.equal(!result.isError, allowed, textOf(result));
    });
  }
});

test("a named application key needs the explicit authentication level for the operation", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = stubAuth();
  for (const level of [undefined, "read", "write"]) {
    const key = apiKeyAuthInfo("test-key", {
      sub: APP, organization_id: ORG, api_key: { uuid: "key", scopes: level ? { authentication: level } : {} },
    }, new URL(AUTH));
    await withClient({ hosted: true }, key, async (client) => {
      const tools = (await client.listTools()).tools.map(({ name }) => name);
      for (const [name, args, allowed] of [
        ["didit_authentication_get", {}, !!level],
        ["didit_authentication_method_set", { name: "code", enabled: true }, level === "write"],
      ]) {
        assert.equal(tools.includes(name), allowed);
        requests.length = 0;
        const result = await client.callTool({ name, arguments: args });
        assert.equal(!result.isError, allowed, textOf(result));
        assert.equal(requests.length, allowed ? 1 : 0);
      }
    });
  }
});

test("a key without scopes, the primary secret included, sets up Authentication", async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = stubAuth();
  // Full access covers every resource, Authentication included (service-didit-auth
  // IsAuthenticationSetupCredential, v3.208): a named full-access key and the primary secret.
  for (const api_key of [{ uuid: "key", scopes: null }, { primary: true, scopes: null }]) {
    const key = apiKeyAuthInfo("test-key", { sub: APP, organization_id: ORG, api_key }, new URL(AUTH));
    await withClient({ hosted: true }, key, async (client) => {
      const tools = (await client.listTools()).tools.map(({ name }) => name);
      for (const [name, args] of [
        ["didit_authentication_get", {}],
        ["didit_authentication_method_set", { name: "code", enabled: true }],
      ]) {
        assert.equal(tools.includes(name), true, `${name} listed for ${JSON.stringify(api_key)}`);
        requests.length = 0;
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, undefined, textOf(result));
        assert.equal(requests.length, 1);
      }
    });
  }
  // A reply that carries no `scopes` at all proves nothing: no Authentication tools.
  const unknown = apiKeyAuthInfo("test-key", { sub: APP, organization_id: ORG, api_key: { uuid: "key" } }, new URL(AUTH));
  await withClient({ hosted: true }, unknown, async (client) => {
    const tools = (await client.listTools()).tools.map(({ name }) => name);
    assert.equal(tools.some((name) => name.startsWith("didit_authentication_")), false);
  });
});
