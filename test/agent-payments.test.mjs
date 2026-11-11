import { createRequire } from "node:module";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Agent payments (9 Nov 2026): didit_org_top_up can charge the organization's SAVED card when a person
// turned on the one agent top-up switch. That is offered ONLY on /mcp/payments (unlisted) and on stdio; the directory
// listed /mcp and /mcp/chatgpt never move money. Every backend request carries X-Didit-Agent: mcp.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/introspect/";
delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;

const require = createRequire(import.meta.url);
const { createServer } = require("../dist/index.js");
const { createHttpApp } = require("../dist/http.js");
const { handleModernRpc } = require("../dist/mcp-modern.js");
const { topUp, getBalance } = require("../dist/tools/billing.js");
const { requestContext } = require("../dist/config.js");

const API = "https://verification.didit.me/v3";
const USER = { token: "user-bearer", clientId: "test", scopes: ["didit:management"], extra: { organization_id: "org-1" } };
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const PAID = { outcome: "paid", top_up: { id: "t-1", status: "paid", credit_amount: "100.00" } };

async function withClient(options, authInfo, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo });
  }
  const client = new Client({ name: "agent-payments-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const inContext = (ctx, fn) => requestContext.run(ctx, fn);
const call = (client, args) => client.callTool({ name: "didit_org_top_up", arguments: args });

// ── toolsets ─────────────────────────────────────────────────────────────────────────────────

test("the payments endpoint lists its money tool under the short catalog too; /mcp does not", async () => {
  const { parseSelection } = require("../dist/toolsets.js");
  const core = parseSelection(undefined, false, "core");
  const names = (options) => withClient(options, USER, async (client) => (await client.listTools()).tools.map((tool) => tool.name));

  const payments = await names({ hosted: true, moneyTools: true, selection: core });
  assert.ok(payments.includes("didit_org_top_up"), "an agent that connects to /mcp/payments came for this tool");
  assert.ok(payments.length <= 31, `${payments.length} tools: the core catalog plus the money tool`);

  const main = await names({ hosted: true, selection: core });
  assert.ok(!main.includes("didit_org_top_up"));

  // Read-only wins: a connection that asked never to change anything is not offered a way to pay.
  const readOnly = await names({ hosted: true, moneyTools: true, selection: parseSelection(undefined, true, "core") });
  assert.ok(!readOnly.includes("didit_org_top_up"));
});

// ── the tool ──────────────────────────────────────────────────────────────────────────────────

test("saved_card with a Bearer posts to the console agent route with Idempotency-Key and X-Didit-Agent", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return json(PAID, 201);
  };
  const res = await inContext({ accessToken: "tok" }, () =>
    topUp(100, true, "org-9", { payment_method: "saved_card", idempotency_key: "key-1" }),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${API}/organization/org-9/billing/agent-top-ups/`);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers["Idempotency-Key"], "key-1");
  assert.equal(seen[0].init.headers["X-Didit-Agent"], "mcp");
  assert.equal(seen[0].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(seen[0].init.body), { amount_in_dollars: 100 });
  assert.deepEqual(res, PAID, "the backend body is the result, unchanged");
});

test("saved_card without a valid idempotency_key is refused locally, before any request", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return json(PAID);
  };
  for (const key of [undefined, "", "   ", 7, "x".repeat(256)]) {
    const err = await inContext({ accessToken: "tok", organizationId: "org-1" }, () =>
      topUp(100, true, undefined, { payment_method: "saved_card", idempotency_key: key }),
    ).then(() => null, (e) => e);
    assert.ok(err, `key ${JSON.stringify(key)} must be refused`);
    assert.equal(err.shape.field, "idempotency_key");
    assert.match(err.shape.hint, /reuse the same key/);
  }
  assert.equal(called, false);
});

test("an unknown payment_method, an unconfirmed saved_card and the $50-$20,000 bounds are refused locally", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return json(PAID);
  };
  const ctx = { accessToken: "tok", organizationId: "org-1" };
  const refusal = (amount, confirm, options) =>
    inContext(ctx, () => topUp(amount, confirm, undefined, options)).then(() => null, (e) => e);
  assert.equal((await refusal(100, true, { payment_method: "wire" })).shape.field, "payment_method");
  assert.equal((await refusal(100, undefined, { payment_method: "saved_card", idempotency_key: "k" })).shape.code, "unsafe_operation");
  assert.equal((await refusal(100, false, { payment_method: "saved_card", idempotency_key: "k" })).shape.code, "unsafe_operation");
  assert.match((await refusal(49, true, { payment_method: "saved_card", idempotency_key: "k" })).message, /Minimum/);
  assert.match((await refusal(20_001, true, { payment_method: "saved_card", idempotency_key: "k" })).message, /maximum/);
  assert.equal(called, false);
});

test("a backend refusal keeps its code, detail and next_step, and is never retried", async () => {
  const body = {
    code: "agent_top_up_not_enabled",
    detail: "A person has not turned on agent top-ups.",
    next_step: {
      action: "top_up_in_console",
      url: "https://business.didit.me/console/org-1/settings/billing?top_up_amount=900",
      description: "A person tops up in the console, or turns on the switch.",
    },
  };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    return json(body, 403);
  };
  const result = await withClient({ hosted: true, moneyTools: true }, USER, (client) =>
    call(client, { amount_in_dollars: 900, confirm: true, payment_method: "saved_card", idempotency_key: "key-3" }),
  );
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /Error \[agent_top_up_not_enabled\]: A person has not turned on agent top-ups\./);
  assert.match(text, /Next step: .*"action":"top_up_in_console".*top_up_amount=900.*"description":"A person tops up/);
  assert.deepEqual(calls.filter((c) => c.startsWith("POST")), ["POST /v3/organization/org-1/billing/agent-top-ups/"], "the POST is sent once, never auto-retried");
});

test("the checkout method is unchanged: GET checkout-session, no Idempotency-Key", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return json({ checkout_session_url: "https://checkout.stripe.com/c/pay/cs_1" });
  };
  await inContext({ accessToken: "tok" }, () => topUp(150, true, "org-9"));
  assert.equal(seen[0].url, `${API}/organization/org-9/checkout-session/?amount_in_dollars=150`);
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.headers["Idempotency-Key"], undefined);
});

test("the tool schema and description teach the idempotency key and the refusal codes", async () => {
  const tool = await withClient({}, undefined, async (c) => (await c.listTools()).tools.find((t) => t.name === "didit_org_top_up"));
  assert.deepEqual(tool.inputSchema.properties.payment_method.enum, ["checkout", "saved_card"]);
  assert.equal(tool.inputSchema.properties.idempotency_key.maxLength, 255);
  assert.deepEqual(tool.inputSchema.required, ["amount_in_dollars"]);
  for (const word of [
    "ONE unique key per intended top-up",
    "reuse that same key",
    "agent_top_up_not_enabled",
    "authentication_required",
    "payment_method_required",
    "card_declined",
    "Connected AI agents can top up with your saved card",
    "next_step.url",
  ]) {
    assert.ok(tool.description.includes(word), `description misses: ${word}`);
  }
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.openWorldHint, true);
});

// ── the money gate ────────────────────────────────────────────────────────────────────────────

const REFUSED = /Top-ups are paid by the person in the Didit console/;

for (const [label, options] of [
  ["/mcp (full)", { hosted: true, profile: "full" }],
  ["/mcp (default options)", { hosted: true }],
  ["/mcp/chatgpt", { hosted: true, profile: "chatgpt" }],
  ["a reduced profile even when moneyTools is asked for", { hosted: true, profile: "chatgpt", moneyTools: true }],
]) {
  test(`${label}: didit_org_top_up is unlisted and refused for both payment methods`, async () => {
    let fetched = false;
    globalThis.fetch = async (url) => {
      // Only the best-effort signed request link may be requested (no payment, no money).
      if (String(url).includes("/billing/top-up-requests/")) return json({ detail: "down" }, 500);
      fetched = true;
      return json(PAID);
    };
    await withClient(options, USER, async (client) => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(!names.includes("didit_org_top_up"));
      for (const args of [
        { amount_in_dollars: 100, confirm: true },
        { amount_in_dollars: 100, confirm: true, payment_method: "checkout" },
        { amount_in_dollars: 100, confirm: true, payment_method: "saved_card", idempotency_key: "k" },
      ]) {
        const result = await call(client, args);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, REFUSED);
        assert.match(result.content[0].text, /next_steps\.top_up_url/);
      }
    });
    assert.equal(fetched, false);
  });
}

test("moneyTools lists and allows didit_org_top_up (the payments endpoint)", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return json(PAID, 201);
  };
  await withClient({ hosted: true, profile: "full", moneyTools: true }, USER, async (client) => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("didit_org_top_up"));
    assert.ok(names.includes("didit_org_get_balance"), "the full catalog is served too");
    for (const method of ["saved_card"]) {
      const result = await call(client, { amount_in_dollars: 100, confirm: true, payment_method: method, idempotency_key: "key-4" });
      assert.notEqual(result.isError, true, result.content[0].text);
    }
  });
  // Exactly one charge. Other requests may precede it (the default org/app lookup is cached per process, so
  // whether it fetches depends on which tests ran before this one), so count the charge route only.
  const charges = seen.filter((c) => c.url === `${API}/organization/org-1/billing/agent-top-ups/`);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].init.headers["Idempotency-Key"], "key-4");
});

test("the modern-RPC path applies the same gate", async () => {
  globalThis.fetch = async () => json(PAID, 201);
  const rpc = (method, params) => ({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  });
  const args = { name: "didit_org_top_up", arguments: { amount_in_dollars: 100, confirm: true, payment_method: "saved_card", idempotency_key: "k" } };

  const closed = await handleModernRpc(rpc("tools/call", args), USER, { profile: "full" });
  assert.equal(closed.result.isError, true);
  assert.match(closed.result.content[0].text, REFUSED);
  const closedList = await handleModernRpc(rpc("tools/list", {}), USER, { profile: "full" });
  assert.ok(!closedList.result.tools.some((t) => t.name === "didit_org_top_up"));

  const open = await handleModernRpc(rpc("tools/call", args), USER, { profile: "full", moneyTools: true });
  assert.notEqual(open.result.isError, true);
  const openList = await handleModernRpc(rpc("tools/list", {}), USER, { profile: "full", moneyTools: true });
  assert.ok(openList.result.tools.some((t) => t.name === "didit_org_top_up"));
});

// ── balance enrichment ────────────────────────────────────────────────────────────────────────

const SPENDING = { enabled: true, updated_at: "2026-11-09T10:00:00Z", updated_by: "alex@acme.com" };
const SWITCH = { enabled: true };

function stubBalance({ spending }) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url).split("?")[0];
    seen.push({ path, init });
    if (path.endsWith("/top-up/")) return json({ balance: "10.00" });
    if (path.endsWith("/credits/")) return json({});
    if (path.endsWith("/billing/agent-spending/")) return spending();
    return json({ detail: "Not found." }, 404);
  };
  return seen;
}

test("balance adds agent_top_up on the payments endpoint and on stdio, never on /mcp or /mcp/chatgpt", async () => {
  const run = (options, authInfo) =>
    withClient(options, authInfo, (client) => client.callTool({ name: "didit_org_get_balance", arguments: {} }));
  const parse = (result) => JSON.parse(result.content[0].text);

  stubBalance({ spending: () => json(SPENDING) });
  assert.deepEqual(parse(await run({ hosted: true, moneyTools: true }, USER)).agent_top_up, SWITCH);
  process.env.DIDIT_ACCESS_TOKEN = "local-token";
  process.env.MCP_DEFAULT_ORG = "org-1";
  try {
    assert.deepEqual(parse(await run({}, undefined)).agent_top_up, SWITCH, "stdio");
  } finally {
    delete process.env.DIDIT_ACCESS_TOKEN;
    delete process.env.MCP_DEFAULT_ORG;
  }

  for (const options of [{ hosted: true }, { hosted: true, profile: "chatgpt" }]) {
    const seen = stubBalance({ spending: () => json(SPENDING) });
    const body = parse(await run(options, USER));
    assert.equal(body.agent_top_up, undefined);
    assert.ok(!seen.some((r) => r.path.endsWith("/billing/agent-spending/")), "the switch is not even requested");
  }
});

test("a failing agent-spending switch read never fails the balance", async () => {
  for (const spending of [() => json({ detail: "nope" }, 403), () => json({ detail: "boom" }, 500), () => Promise.reject(new Error("fetch failed"))]) {
    stubBalance({ spending });
    const balance = await inContext({ accessToken: "tok", organizationId: "org-1" }, () => getBalance(undefined, { agentTopUp: true }));
    assert.equal(balance.balance, "10.00");
    assert.equal(balance.agent_top_up, undefined);
  }
});

// ── X-Didit-Agent on every backend request ────────────────────────────────────────────────────

test("every backend request carries X-Didit-Agent: mcp, whatever the tool or base URL", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return json({});
  };
  const { apiRequest } = require("../dist/config.js");
  await inContext({ accessToken: "tok" }, async () => {
    await apiRequest("/sessions/");
    await apiRequest("/x/", { method: "POST", json: {}, headers: { Authorization: "Bearer other" } });
    await apiRequest("/orgs/", { baseUrl: "https://apx.didit.me/auth/v2" });
    await apiRequest("/up/", { method: "POST", form: new FormData() });
  });
  assert.equal(seen.length, 4);
  for (const request of seen) assert.equal(request.headers["X-Didit-Agent"], "mcp", request.url);
});

test("the token introspection call carries it too", async () => {
  const { IntrospectionTokenVerifier } = await import("../dist/auth/introspection-verifier.js");
  let headers;
  globalThis.fetch = async (_url, init) => {
    headers = init.headers;
    return json({ active: true, sub: "u" });
  };
  await new IntrospectionTokenVerifier().verifyAccessToken("header.payload.signature");
  assert.equal(headers["X-Didit-Agent"], "mcp");
});

// ── the HTTP endpoints ────────────────────────────────────────────────────────────────────────

function request(server, path, { method = "GET", body, headers = {} } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: body ? { "Content-Type": "application/json", ...headers } : headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : undefined }));
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function stubHttpFetch() {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === process.env.DIDIT_OIDC_DISCOVERY_URL) {
      return json({
        issuer: "https://business.didit.me",
        authorization_endpoint: "https://business.didit.me/authorize",
        token_endpoint: "https://business.didit.me/api/auth/oauth-token",
        scopes_supported: ["didit:management"],
      });
    }
    if (target === process.env.MCP_OAUTH_INTROSPECT_URL) return json({ active: true, sub: "u-1", organization_id: "org-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    return json({});
  };
}

const modernList = (path) => ({
  method: "POST",
  headers: { Authorization: "Bearer good.access.token", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
  body: {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  },
});

test("/mcp/payments publishes its own protected-resource metadata and challenge", async (t) => {
  stubHttpFetch();
  const server = (await createHttpApp()).listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const meta = await request(server, "/.well-known/oauth-protected-resource/mcp/payments");
  assert.equal(meta.status, 200);
  assert.equal(meta.body.resource, "https://mcp.didit.me/mcp/payments");
  assert.equal(meta.body.resource_name, "Didit MCP (agent payments)");
  assert.deepEqual(meta.body.authorization_servers, ["https://business.didit.me"]);
  assert.equal((await request(server, "/.well-known/oauth-protected-resource/mcp")).body.resource, "https://mcp.didit.me/mcp");

  const challenge = await request(server, "/mcp/payments", { method: "POST", body: {} });
  assert.equal(challenge.status, 401);
  assert.match(
    challenge.headers["www-authenticate"],
    /resource_metadata="https:\/\/mcp\.didit\.me\/\.well-known\/oauth-protected-resource\/mcp\/payments"/,
  );
  assert.equal((await request(server, "/mcp/payments", { method: "GET" })).status, 405);
});

test("over HTTP only /mcp/payments lists didit_org_top_up", async (t) => {
  stubHttpFetch();
  const server = (await createHttpApp()).listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const listed = async (path) => {
    const { headers, body, method } = modernList(path);
    const res = await request(server, path, { method, headers, body });
    assert.equal(res.status, 200, path);
    return res.body.result.tools.map((tool) => tool.name);
  };
  assert.ok((await listed("/mcp/payments")).includes("didit_org_top_up"));
  assert.ok(!(await listed("/mcp")).includes("didit_org_top_up"));
  // /mcp/chatgpt never lists it either: http-chatgpt-endpoint.test.mjs (the public build has no such route).
});

// ── the signed top-up request link (design item 9) ────────────────────────────────────────────

const SIGNED = "https://business.didit.me/console/org-1/settings/billing?top_up_amount=500&top_up_request=signed.token";

test("the hosted refusal carries the signed request link for the amount", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return json({ url: SIGNED, amount: "500.00", expires_at: "2026-11-10T10:00:00Z" }, 201);
  };
  await withClient({ hosted: true }, USER, async (client) => {
    const result = await call(client, { amount_in_dollars: 500, confirm: true, payment_method: "saved_card", idempotency_key: "k" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes(SIGNED));
    assert.match(result.content[0].text, /Top-ups are paid by the person/);
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${API}/organization/org-1/billing/top-up-requests/`);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers["X-Didit-Agent"], "mcp");
  assert.deepEqual(JSON.parse(seen[0].init.body), { amount_in_dollars: 500 });
});

test("the hosted refusal falls back to the static text when the signing call fails or has no amount", async () => {
  for (const [fetcher, amount] of [
    [async () => json({ detail: "boom" }, 500), 500],
    [() => Promise.reject(new Error("fetch failed")), 500],
    [async () => json({ url: SIGNED }, 201), undefined],
  ]) {
    globalThis.fetch = fetcher;
    await withClient({ hosted: true, profile: "chatgpt" }, USER, async (client) => {
      const result = await call(client, { amount_in_dollars: amount, confirm: true, payment_method: "saved_card", idempotency_key: "k" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /next_steps\.top_up_url/);
      assert.ok(!result.content[0].text.includes("top_up_request="));
    });
  }
});

test("checkout top-up hands over the signed link, and the unsigned link when signing fails", async () => {
  const stub = (signing) => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/top-up-requests/")) return signing();
      return json({ checkout_session_url: "https://checkout.stripe.com/c/pay/cs_1" });
    };
  };
  stub(async () => json({ url: SIGNED }, 201));
  const signed = await inContext({ accessToken: "tok" }, () => topUp(500, true, "org-1"));
  assert.equal(signed.next_steps.console_top_up_url, SIGNED);

  stub(async () => json({ detail: "boom" }, 500));
  const fallback = await inContext({ accessToken: "tok" }, () => topUp(500, true, "org-1"));
  assert.equal(fallback.next_steps.console_top_up_url, "https://business.didit.me/console/org-1/settings/billing?top_up_amount=500");
});

test("balance links stay unsigned: no amount is known", async () => {
  const seen = stubBalance({ spending: () => json(SPENDING) });
  const balance = await inContext({ accessToken: "tok", organizationId: "org-1" }, () => getBalance(undefined, { links: true }));
  assert.match(balance.next_steps.top_up_url, /top_up_amount=100$/);
  assert.ok(!seen.some((r) => r.path.includes("top-up-requests")));
});
