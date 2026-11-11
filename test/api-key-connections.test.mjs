import { createRequire } from "node:module";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Alex, 11 Nov 2026: an agent with no person present (CI, a scheduled job, a backend agent) must be
// able to use the hosted server. It connects with the application API key it already sends to the
// Didit API. The connection is that one application: the key goes out as x-api-key, the API decides
// what it may do, and the tools that act for a member of an organization are not on it.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/introspect/";
delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;
delete process.env.MCP_DEFAULT_ORG;
delete process.env.MCP_DEFAULT_APP;

const require = createRequire(import.meta.url);
const { createServer } = require("../dist/index.js");
const { createHttpApp } = require("../dist/http.js");
const { IntrospectionTokenVerifier } = require("../dist/auth/introspection-verifier.js");
const { PERSON_ONLY_TOOLS, apiKeyAuthInfo, looksLikeApiKey } = require("../dist/api-key-connection.js");
const { profileServesWidgets } = require("../dist/chatgpt-app.js");
const { parseSelection } = require("../dist/toolsets.js");

const API = "https://verification.didit.me/v3";
const ORG = "69f2b990-24e3-4892-bbe7-1a6a628943b3";
const APP = "5bfe5319-625d-487c-a9c3-8f3cf50750b8";
const OTHER_APP = "11111111-2222-4333-8444-555555555555";
const KEY = "sk_test_9c2fAbCdEfGhIjKlMnOpQrStUvWxYz012345";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJl";
const KEY_ID = "0b0b0b0b-1c1c-4d1d-8e1e-2f2f2f2f2f2f";

/** What service-didit-auth answers when it introspects an application API key. */
const introspected = (apiKey = {}) => ({
  active: true,
  sub: APP,
  client_id: "client-of-the-application",
  organization_id: ORG,
  organization_name: "Acme",
  application_name: "Acme (Sandbox)",
  application_mode: "sandbox",
  claims: ["read:email"],
  api_key: { uuid: KEY_ID, label: "CI", prefix: "sk_test_9c2f", primary: false, scopes: null, allowed_ips: [], expires_at: null, ...apiKey },
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const keyAuth = (apiKey) => apiKeyAuthInfo(KEY, introspected(apiKey), new URL(process.env.MCP_RESOURCE_URI));

/** Record every outgoing request; answer each with `answer(url, init)` (default: an empty list). */
function backend(answer = () => json({ results: [] })) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    return answer(String(url), init);
  };
  return seen;
}

async function withClient({ authInfo = keyAuth(), profile, moneyTools, selection, apiKey } = {}, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({
    hosted: true,
    ...(profile ? { profile } : {}),
    ...(moneyTools ? { moneyTools } : {}),
    ...(selection ? { selection } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo });
  const client = new Client({ name: "api-key-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const call = (name, args = {}, opts) => withClient(opts, (c) => c.callTool({ name, arguments: args }));
const text = (result) => result.content[0].text;

// ── Telling a key from a token, and what an accepted key becomes ─────────────

test("a key is told from a token by its shape", () => {
  assert.equal(looksLikeApiKey(KEY), true);
  assert.equal(looksLikeApiKey("legacyKeyWithoutMarker_-0123456789"), true);
  assert.equal(looksLikeApiKey(JWT), false);
  assert.equal(looksLikeApiKey(""), false);
});

test("the verifier introspects a key as api_key and a token as token, one request each", async () => {
  const seen = backend(() => json(introspected()));
  const info = await new IntrospectionTokenVerifier().verifyAccessToken(KEY);
  assert.deepEqual(JSON.parse(seen[0].body), { api_key: KEY });
  assert.equal(seen.length, 1);
  assert.equal(info.extra.credential, "api_key");
  assert.equal(info.extra.organization_id, ORG);
  assert.equal(info.extra.api_key.applicationId, APP);
  assert.equal(info.extra.api_key.mode, "sandbox");
  assert.equal(info.extra.api_key.keyId, KEY_ID);
  assert.equal(info.extra.api_key.restricted, false);
  assert.equal(info.extra.is_privileged, false);

  const forToken = backend(() => json({ active: true, sub: "u-1", organization_id: ORG, exp: Math.floor(Date.now() / 1000) + 600 }));
  const person = await new IntrospectionTokenVerifier().verifyAccessToken(JWT);
  assert.deepEqual(JSON.parse(forToken[0].body), { token: JWT });
  assert.equal(person.extra.credential, undefined);
});

test("a key carries no role permissions, so the role pre-check never judges it", () => {
  // The application's own claims look like permissions to nothing here: scopes stays empty.
  assert.deepEqual(keyAuth().scopes, []);
});

test("every accepted key has an expiry the SDK accepts, never later than the key's own", () => {
  const now = Date.now();
  const noExpiry = apiKeyAuthInfo(KEY, introspected(), new URL(process.env.MCP_RESOURCE_URI), now);
  assert.equal(noExpiry.expiresAt, Math.floor(now / 1000) + 3600);

  const soon = new Date(now + 120_000).toISOString();
  const expiring = apiKeyAuthInfo(KEY, introspected({ expires_at: soon }), new URL(process.env.MCP_RESOURCE_URI), now);
  assert.equal(expiring.expiresAt, Math.floor(Date.parse(soon) / 1000));
});

test("a restricted key is marked restricted", () => {
  assert.equal(keyAuth({ scopes: { sessions: "read" } }).extra.api_key.restricted, true);
});

test("the application's primary key has no id and is marked primary, in the audit line too", async () => {
  // What service-didit-auth answers for the primary key (`primary_access_payload`).
  const primary = keyAuth({ uuid: null, label: "Primary", primary: true, allowed_ips: null });
  assert.equal(primary.extra.api_key.keyId, undefined);
  assert.equal(primary.extra.api_key.primary, true);
  assert.equal(primary.extra.api_key.restricted, false);

  backend();
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await call("didit_workflow_list", {}, { authInfo: primary });
  } finally {
    console.error = original;
  }
  const audit = lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(JSON.parse(line).message)).find((line) => line.event === "mcp.tool_call");
  assert.equal(audit.credential, "api_key");
  assert.equal(audit.api_key_primary, true);
  assert.equal(audit.api_key_id, undefined);
});

test("an unknown, revoked or expired key is an invalid credential", async () => {
  backend(() => json({ active: false }));
  await assert.rejects(new IntrospectionTokenVerifier().verifyAccessToken(KEY), (error) => {
    assert.equal(error.constructor.name, "InvalidTokenError");
    assert.match(error.message, /API key is invalid, revoked or expired/);
    return true;
  });
});

test("a key limited to IP addresses is refused with the reason, before any tool runs", async () => {
  backend(() => json(introspected({ allowed_ips: ["203.0.113.7"] })));
  await assert.rejects(new IntrospectionTokenVerifier().verifyAccessToken(KEY), (error) => {
    assert.equal(error.constructor.name, "InvalidTokenError");
    assert.match(error.message, /limited to specific IP addresses/);
    return true;
  });
});

test("an answer that names no application is refused", () => {
  assert.throws(
    () => apiKeyAuthInfo(KEY, { active: true, organization_id: ORG }, new URL(process.env.MCP_RESOURCE_URI)),
    /could not be matched to an application/,
  );
});

// ── The catalog of an API key connection ────────────────────────────────────

test("the catalog leaves out exactly the tools that need a person", async () => {
  backend();
  const person = { token: JWT, clientId: "c", scopes: [], extra: { organization_id: ORG } };
  const [forKey, forPerson] = await Promise.all([
    withClient({}, async (c) => (await c.listTools()).tools.map((t) => t.name)),
    withClient({ authInfo: person }, async (c) => (await c.listTools()).tools.map((t) => t.name)),
  ]);
  const missing = forPerson.filter((name) => !forKey.includes(name)).sort();
  // The key reveal is already absent from every remote connection, so it is not in the difference.
  const expected = [...PERSON_ONLY_TOOLS].filter((name) => forPerson.includes(name)).sort();
  assert.deepEqual(missing, expected);
  assert.ok(missing.includes("didit_org_create_api_key"));
  assert.ok(missing.includes("didit_billing_get_plan"));
  assert.ok(missing.includes("didit_session_generate_pdf"));
  for (const name of ["didit_context_get", "didit_workflow_create", "didit_session_create", "didit_org_get_balance", "didit_webhook_create"]) {
    assert.ok(forKey.includes(name), `${name} is missing from an API key connection`);
  }
  assert.deepEqual(forKey.filter((name) => !forPerson.includes(name)), [], "an API key connection lists nothing a person does not");
});

test("every person-only tool exists in the catalog (a renamed tool cannot silently escape the list)", async () => {
  // The local server lists every tool, the ones a remote connection never gets included.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const local = createServer({});
  await local.connect(serverTransport);
  const client = new Client({ name: "names", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  let tools;
  try {
    ({ tools } = await client.listTools());
  } finally {
    await client.close();
    await local.close();
  }
  const names = new Set(tools.map((t) => t.name));
  for (const name of PERSON_ONLY_TOOLS) assert.ok(names.has(name), `${name} is not a tool`);
});

// ── Calls ───────────────────────────────────────────────────────────────────

test("a call goes out with x-api-key, no Bearer, on the key's own application", async () => {
  const seen = backend();
  const result = await call("didit_workflow_list");
  assert.notEqual(result.isError, true, text(result));
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.startsWith(`${API}/organization/${ORG}/application/${APP}/`), seen[0].url);
  assert.equal(seen[0].headers["x-api-key"], KEY);
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.equal(seen[0].headers["X-Didit-Organization-Id"], undefined);
  assert.equal(seen[0].headers["X-Didit-Agent"], "mcp");
});

test("naming the key's own ids is accepted, in any letter case", async () => {
  const seen = backend();
  const result = await call("didit_workflow_list", { organization_id: ORG.toUpperCase(), application_id: APP });
  assert.notEqual(result.isError, true, text(result));
  assert.ok(seen[0].url.includes(`/application/${APP}/`));
});

test("a call that names another application or organization is refused and nothing is sent", async () => {
  const seen = backend();
  const otherApp = await call("didit_workflow_list", { application_id: OTHER_APP });
  assert.equal(otherApp.isError, true);
  assert.match(text(otherApp), /acts on one application only/);
  assert.match(text(otherApp), new RegExp(APP));
  const otherOrg = await call("didit_session_list", { organization_id: OTHER_APP });
  assert.equal(otherOrg.isError, true);
  assert.equal(seen.length, 0);
});

test("a person-only tool is refused on call even though it is not listed, and nothing is sent", async () => {
  const seen = backend();
  for (const name of ["didit_org_list_members", "didit_billing_get_plan", "didit_org_create_api_key"]) {
    const result = await call(name, { organization_id: ORG, application_id: APP, confirm: true });
    assert.equal(result.isError, true, name);
    assert.match(text(result), /acts for a member of the organization/, name);
  }
  const pdf = await call("didit_session_generate_pdf", { session_id: "5bfe5319-625d-487c-a9c3-8f3cf50750b9" });
  assert.equal(pdf.isError, true);
  assert.match(text(pdf), /download link/);
  assert.equal(seen.length, 0);
});

test("the audit log and the workflow builder, which the API only answers for a member, are not on a key connection", async () => {
  const seen = backend();
  const names = await withClient({}, async (c) => (await c.listTools()).tools.map((t) => t.name));
  for (const name of ["didit_audit_log_list", "didit_workflow_build_graph"]) {
    assert.ok(!names.includes(name), `${name} is listed to an API key connection`);
    const result = await call(name, { features: [{ feature: "OCR" }] });
    assert.equal(result.isError, true, name);
  }
  assert.equal(seen.length, 0);
});

test("a 403 from the API is explained as the key's access, never as a role", async () => {
  backend(() => json({ detail: "This API key does not have access to webhooks." }, 403));
  const forKey = await call("didit_webhook_list");
  assert.equal(forKey.isError, true);
  assert.match(text(forKey), /This connection uses an API key/);
  assert.doesNotMatch(text(forKey), /different role/);

  backend(() => json({ detail: "You do not have permission to perform this action." }, 403));
  const person = { token: `${JWT}y`, clientId: "c", scopes: [], extra: { organization_id: ORG } };
  const forPerson = await call("didit_webhook_list", { organization_id: ORG, application_id: APP }, { authInfo: person });
  assert.match(text(forPerson), /different role/);
});

test("didit_context_get describes the one application without asking the auth service", async () => {
  const seen = backend();
  const context = JSON.parse(text(await call("didit_context_get")));
  assert.equal(seen.length, 0);
  assert.equal(context.connection.type, "api_key");
  assert.equal(context.connection.access, "full");
  assert.equal(context.connection.key_prefix, "sk_test_9c2f");
  assert.equal(context.default_organization_id, ORG);
  assert.equal(context.default_application_id, APP);
  assert.deepEqual(context.organizations, [
    {
      organization_id: ORG,
      organization_name: "Acme",
      applications: [{ application_id: APP, application_name: "Acme (Sandbox)", mode: "sandbox" }],
    },
  ]);
  assert.ok(!JSON.stringify(context).includes(KEY), "the key must never be echoed");
});

test("a person's connection gets no connection block in didit_context_get", async () => {
  backend((url) => (url.endsWith("/organizations/me/") ? json([{ uuid: ORG, name: "Acme" }]) : json([{ uuid: APP, name: "App", mode: "live" }])));
  const person = { token: `${JWT}x`, clientId: "c", scopes: [], extra: { organization_id: ORG } };
  const context = JSON.parse(text(await call("didit_context_get", {}, { authInfo: person })));
  assert.equal(context.connection, undefined);
});

test("the organization and application lookups answer from the key", async () => {
  const seen = backend();
  const orgs = await call("didit_org_list");
  assert.deepEqual(orgs.structuredContent, { value: [{ uuid: ORG, name: "Acme" }] });
  const apps = await call("didit_org_list_applications", { organization_id: ORG });
  assert.deepEqual(apps.structuredContent.value, [{ uuid: APP, name: "Acme (Sandbox)", mode: "sandbox", organization_id: ORG }]);
  const app = await call("didit_org_get_application", { organization_id: ORG, application_id: APP });
  assert.equal(app.structuredContent.uuid, APP);
  assert.equal(seen.length, 0);
});

test("a search reads the key's application and never the organization-wide route", async () => {
  const seen = backend();
  const result = await call("didit_session_search", { limit: 5 });
  assert.notEqual(result.isError, true, text(result));
  assert.ok(seen.length >= 1);
  for (const request of seen) {
    assert.ok(request.url.includes(`/organization/${ORG}/application/${APP}/`), `organization-wide request: ${request.url}`);
    assert.equal(request.headers["x-api-key"], KEY);
  }
});

test("the balance comes from the public API route for a key, with the console links", async () => {
  const seen = backend(() => json({ balance: "12.50", auto_refill_enabled: false, agent_top_up: { enabled: true } }));
  const balance = JSON.parse(text(await call("didit_org_get_balance")));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${API}/billing/balance/`);
  assert.equal(balance.balance, "12.50");
  assert.ok(balance.next_steps.top_up_url.includes(`/console/${ORG}/settings/billing`));
  // The agent top-up switch is only reported where an agent may top up: not on /mcp.
  assert.equal(balance.agent_top_up, undefined);
});

test("on the payments endpoint a key tops up through the public API route", async () => {
  const seen = backend((url) =>
    url.endsWith("/billing/balance/")
      ? json({ balance: "1.00", agent_top_up: { enabled: true } })
      : json({ outcome: "succeeded", top_up: { amount: "100.00" } }, 201),
  );
  const balance = JSON.parse(text(await call("didit_org_get_balance", {}, { moneyTools: true })));
  assert.deepEqual(balance.agent_top_up, { enabled: true });

  const charged = await call(
    "didit_org_top_up",
    { amount_in_dollars: 100, confirm: true, payment_method: "saved_card", idempotency_key: "top-up-1" },
    { moneyTools: true },
  );
  assert.notEqual(charged.isError, true, text(charged));
  const post = seen.find((request) => request.method === "POST");
  assert.equal(post.url, `${API}/billing/top-up/`);
  assert.deepEqual(JSON.parse(post.body), { amount_in_dollars: 100, payment_method: "saved_card" });
  assert.equal(post.headers["Idempotency-Key"], "top-up-1");
  assert.equal(post.headers["x-api-key"], KEY);

  seen.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    return json({ checkout_session_id: "cs_1", checkout_session_url: "https://checkout.stripe.com/c/pay/cs_1" });
  };
  const checkout = JSON.parse(text(await call("didit_org_top_up", { amount_in_dollars: 50, confirm: true }, { moneyTools: true })));
  assert.equal(seen[0].url, `${API}/billing/top-up/`);
  assert.deepEqual(JSON.parse(seen[0].body), { amount_in_dollars: 50 });
  assert.equal(checkout.checkout_session_url, "https://checkout.stripe.com/c/pay/cs_1");
  assert.equal(checkout.requires_human_approval, true);
});

test("the audit line names the key by its id and never contains the key", async () => {
  backend();
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await call("didit_workflow_list");
  } finally {
    console.error = original;
  }
  const audit = lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(JSON.parse(line).message)).find((line) => line.event === "mcp.tool_call");
  assert.equal(audit.credential, "api_key");
  assert.equal(audit.api_key_id, KEY_ID);
  assert.equal(audit.api_key_primary, undefined);
  assert.equal(audit.sub, APP);
  assert.equal(audit.organization_id, ORG);
  assert.ok(!lines.join("\n").includes(KEY), "the key was written to the log");
});

// ── Through the discovery tools, and what the server says about itself ──────

test("a call through the discovery proxy is held to the key's application and to the person-only rule", async () => {
  const seen = backend();
  const core = { selection: parseSelection("core", false) };
  const names = await withClient(core, async (c) => (await c.listTools()).tools.map((t) => t.name));
  assert.ok(names.includes("didit_tool_call_write"), "a short catalog lists the discovery tools");

  const personOnly = await call(
    "didit_tool_call_write",
    { name: "didit_org_invite_member", arguments: { email: "new@acme.test", role: "DEVELOPER" } },
    core,
  );
  assert.equal(personOnly.isError, true);
  assert.match(text(personOnly), /acts for a member of the organization/);

  for (const proxy of ["didit_tool_call_read", "didit_tool_call_write"]) {
    const otherApplication = await call(proxy, { name: "didit_workflow_list", arguments: { application_id: OTHER_APP } }, core);
    assert.equal(otherApplication.isError, true, proxy);
    assert.match(text(otherApplication), /acts on one application only/, proxy);
  }
  assert.equal(seen.length, 0, "a refused proxied call sends nothing");

  // The same proxy runs an unlisted tool the key may use, on the key's own application.
  const allowed = await call("didit_tool_call_read", { name: "didit_questionnaire_list", arguments: {} }, core);
  assert.notEqual(allowed.isError, true, text(allowed));
  assert.ok(seen[0].url.includes(`/organization/${ORG}/application/${APP}/`));
  assert.equal(seen[0].headers["x-api-key"], KEY);
});

test("tool search and describe never surface a person-only tool to a key", async () => {
  backend();
  const core = { selection: parseSelection("core", false) };
  const found = JSON.parse(text(await call("didit_tool_search", { query: "invite a member to the organization", limit: 20 }, core)));
  const names = JSON.stringify(found);
  for (const name of ["didit_org_invite_member", "didit_org_list_members", "didit_billing_get_plan", "didit_org_create_api_key"]) {
    assert.ok(!names.includes(name), `${name} was offered to an API key connection`);
  }
  const described = JSON.parse(text(await call("didit_tool_describe", { names: ["didit_org_invite_member", "didit_webhook_get"] }, core)));
  assert.deepEqual(described.tools.map((tool) => tool.name), ["didit_webhook_get"]);
  assert.deepEqual(described.not_found.map((tool) => tool.name), ["didit_org_invite_member"]);
});

async function instructionsOf(options) {
  return withClient(options, async (c) => c.getInstructions());
}

test("the instructions describe a key connection as its application, never as a signed-in person", async () => {
  const forKey = await instructionsOf({ apiKey: true });
  assert.match(forKey, /acts as the application that owns this API key/);
  assert.match(forKey, /organization_id and application_id are never needed/);
  assert.match(forKey, /never ask for a password, an API key or a one-time code/);
  assert.doesNotMatch(forKey, /signed-in person/);
  assert.doesNotMatch(forKey, /handled by OAuth/);
  // Clients cut instructions short: who the connection is has to be in the first paragraph.
  assert.ok(forKey.indexOf("application that owns this API key") < 400);

  const person = { token: JWT, clientId: "c", scopes: [], extra: { organization_id: ORG } };
  const forPerson = await instructionsOf({ authInfo: person });
  assert.match(forPerson, /acts as the signed-in person, with their role's permissions/);
  assert.match(forPerson, /Sign-in is handled by OAuth/);
  assert.doesNotMatch(forPerson, /API key connection|owns this API key/);
});

test("with a short catalog, a key is not told about toolsets that hold nothing it can use", async () => {
  const forKey = await instructionsOf({ apiKey: true, selection: parseSelection("core", false) });
  const forPerson = await instructionsOf({
    authInfo: { token: JWT, clientId: "c", scopes: [], extra: { organization_id: ORG } },
    selection: parseSelection("core", false),
  });
  const more = (instructions) => /More tools exist in: ([^.]+)\./.exec(instructions)[1].split(", ");
  assert.ok(more(forPerson).includes("billing"), "a person can load the billing toolset");
  // Every billing tool needs a person, so that toolset has nothing left to offer a key.
  assert.ok(!more(forKey).includes("billing"), `a key was pointed at the billing toolset: ${more(forKey)}`);
  assert.ok(more(forKey).includes("workflows"));
});

// ── The HTTP endpoint ───────────────────────────────────────────────────────

function post(server, path, body, headers = {}) {
  const { port } = server.address();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const MODERN = { "mcp-protocol-version": "2026-07-28" };
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } };

/** A hosted app whose auth service knows KEY and nothing else. Returns the introspection bodies it saw. */
async function hostedApp() {
  const introspections = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === process.env.DIDIT_OIDC_DISCOVERY_URL) {
      return json({
        issuer: "https://business.didit.me",
        authorization_endpoint: "https://business.didit.me/authorize",
        token_endpoint: "https://business.didit.me/api/auth/oauth-token",
      });
    }
    if (target === process.env.MCP_OAUTH_INTROSPECT_URL) {
      const body = JSON.parse(init.body);
      introspections.push(body);
      return json(body.api_key === KEY ? introspected() : { active: false });
    }
    return json({ results: [] });
  };
  const server = (await createHttpApp()).listen(0);
  return { server, introspections };
}

test("POST /mcp accepts the key as a Bearer and as x-api-key, and lists the key's catalog", async () => {
  const { server, introspections } = await hostedApp();
  try {
    for (const headers of [{ Authorization: `Bearer ${KEY}` }, { "x-api-key": KEY }]) {
      const res = await post(server, "/mcp", listTools, { ...MODERN, "mcp-method": "tools/list", ...headers });
      assert.equal(res.status, 200, res.raw);
      const names = JSON.parse(res.raw).result.tools.map((t) => t.name);
      assert.ok(names.includes("didit_workflow_create"));
      assert.ok(!names.includes("didit_org_list_members"));
    }
    // One introspection: the second request reuses the accepted answer.
    assert.deepEqual(introspections, [{ api_key: KEY }]);
  } finally {
    server.close();
  }
});

test("over HTTP the instructions follow the credential, in the handshake and in server/discover", async () => {
  const { server } = await hostedApp();
  try {
    // The `initialize` handshake Claude Code and Cursor use.
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
    };
    const legacy = await post(server, "/mcp", initialize, { "x-api-key": KEY });
    assert.equal(legacy.status, 200, legacy.raw);
    const frame = legacy.raw.includes("data:") ? legacy.raw.split("\n").find((line) => line.startsWith("data:")).slice(5) : legacy.raw;
    assert.match(JSON.parse(frame).result.instructions, /acts as the application that owns this API key/);

    // The newer stateless discovery call.
    const discover = { jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } };
    const modern = await post(server, "/mcp", discover, { ...MODERN, "mcp-method": "server/discover", "x-api-key": KEY });
    assert.equal(modern.status, 200, modern.raw);
    assert.match(JSON.parse(modern.raw).result.instructions, /acts as the application that owns this API key/);
  } finally {
    server.close();
  }
});

test("POST /mcp answers 401 with the OAuth challenge to an unknown key, and to no credential", async () => {
  const { server } = await hostedApp();
  try {
    const unknown = await post(server, "/mcp", listTools, { ...MODERN, "mcp-method": "tools/list", "x-api-key": "sk_test_unknown" });
    assert.equal(unknown.status, 401);
    assert.match(unknown.headers["www-authenticate"], /API key is invalid, revoked or expired/);
    assert.match(unknown.headers["www-authenticate"], /resource_metadata=/);
    const none = await post(server, "/mcp", listTools, { ...MODERN, "mcp-method": "tools/list" });
    assert.equal(none.status, 401);
  } finally {
    server.close();
  }
});

test("a reduced catalog endpoint does not take an API key", { skip: !profileServesWidgets("chatgpt") }, async () => {
  const { server } = await hostedApp();
  try {
    const res = await post(server, "/mcp/chatgpt", listTools, { ...MODERN, "mcp-method": "tools/list", "x-api-key": KEY });
    assert.equal(res.status, 403);
    assert.match(JSON.parse(res.raw).error.message, /Connect an API key to \/mcp/);
  } finally {
    server.close();
  }
});

test("the browser preflight allows the x-api-key header, and /healthz reports the feature", async () => {
  const { server } = await hostedApp();
  const { port } = server.address();
  try {
    const preflight = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "OPTIONS" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res));
      });
      req.on("error", reject);
      req.end();
    });
    assert.match(preflight.headers["access-control-allow-headers"], /x-api-key/);
    const health = await (await import("node:util")).promisify((cb) =>
      http.get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => cb(null, JSON.parse(raw)));
      }).on("error", cb),
    )();
    assert.ok(health.features.includes("api_key"));
  } finally {
    server.close();
  }
});
