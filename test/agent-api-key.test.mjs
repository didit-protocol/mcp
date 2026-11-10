import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Alex, 9 Nov 2026: the hosted connector creates ONE scoped, revocable API key for the integration an
// agent builds. The auth service enforces scope, one-per-grant, rate limits and the audit; this tool
// passes the explicit ids, the person's confirmation and the narrower access through, and says to
// store the secret at once.

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;

const AUTH = "https://apx.didit.me/auth/v2";
const ORG = "69f2b990-24e3-4892-bbe7-1a6a628943b3";
const APP = "5bfe5319-625d-487c-a9c3-8f3cf50750b8";
const USER = { token: "user-bearer", clientId: "test", scopes: ["didit:management"], extra: { organization_id: ORG } };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function withClient({ hosted = true, profile, authInfo = USER } = {}, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted, ...(profile ? { profile } : {}) });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo });
  const client = new Client({ name: "agent-api-key-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const call = (args, opts) => withClient(opts, (c) => c.callTool({ name: "didit_org_create_api_key", arguments: args }));
const text = (result) => JSON.parse(result.content[0].text);

test("the hosted connector offers the key tool, gated on the person's confirmation", async () => {
  const tools = await withClient({}, async (c) => (await c.listTools()).tools);
  const tool = tools.find((t) => t.name === "didit_org_create_api_key");
  assert.ok(tool, "missing from the hosted catalog");
  assert.deepEqual(tool.inputSchema.required.sort(), ["application_id", "confirm", "organization_id"]);
  assert.equal(tool.annotations.destructiveHint, true);
  // The reduced directory catalog never offers it: pinned in a private-only test file.
});

test("creates the key at the application's api-keys route and says to store it once", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return json({ uuid: "key-1", label: "Acme backend (Codex)", api_key: "sk_test_secret", scopes: { sessions: "write" } }, 201);
  };
  const result = await call({
    organization_id: ORG,
    application_id: APP,
    label: "Acme backend (Codex)",
    scopes: { sessions: "write", workflows: "read" },
    confirm: true,
  });

  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(seen, [
    {
      url: `${AUTH}/organizations/${ORG}/applications/${APP}/api-keys/`,
      method: "POST",
      body: { label: "Acme backend (Codex)", scopes: { sessions: "write", workflows: "read" } },
    },
  ]);
  const payload = text(result);
  assert.equal(payload.api_key, "sk_test_secret");
  assert.equal(payload.shown_once, true);
  assert.match(payload.next_steps, /never shown again/);
});

test("refuses without both explicit ids or without confirm, before any key is created", async () => {
  let called = false;
  globalThis.fetch = async (url, init = {}) => {
    // Scope discovery may read /organizations/me/; only a POST would create a key.
    if ((init.method ?? "GET") === "POST") called = true;
    return json({ results: [] });
  };
  for (const args of [
    { application_id: APP, confirm: true },
    { organization_id: ORG, confirm: true },
    { organization_id: ORG, application_id: APP },
    { organization_id: ORG, application_id: APP, confirm: true, scopes: { "api-keys": "write" } },
  ]) {
    const result = await call(args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(called, false);
});

test("a second key for the same connected app surfaces the backend's refusal", async () => {
  globalThis.fetch = async () =>
    json({ detail: "This connected app already has an API key for this application (sk_test_ab12…).", code: "agent_api_key_exists" }, 409);
  const result = await call({ organization_id: ORG, application_id: APP, confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already has an API key/);
});

test("didit_org_list_api_keys reaches the application the caller named", async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return json([{ uuid: "key-1", label: "Acme", secret_prefix: "sk_test_ab12" }]);
  };
  const result = await withClient({}, (c) =>
    c.callTool({ name: "didit_org_list_api_keys", arguments: { organization_id: ORG, application_id: APP } }),
  );
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(seen, [`${AUTH}/organizations/${ORG}/applications/${APP}/api-keys/`]);
});
