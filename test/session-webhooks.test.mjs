import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { compactWebhookDelivery } from "../dist/tools/sessions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Per-session webhook deliveries for the go-live flow: the copilot creates a
 * sandbox session, waits for Didit to hit the customer's endpoint and reads the
 * HTTP status back. Before these two tools the delivery log existed only in the
 * console's session page, so the copilot could describe a webhook but never
 * tell whether one arrived.
 */
const API = "https://verification.didit.me/v3";
const AUTH_INFO = { token: "tok", clientId: "client", scopes: [], extra: { sub: "u1", organization_id: "org-1" } };
const SESSION = "0c1a3b0e-7c1d-4a2e-9d51-2f8f5c3a1b0d";
const DELIVERY = "5a3e0c2b-1d4f-4c6a-8b7e-9f0a1b2c3d4e";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AUTH = "https://apx.didit.me/auth/v2";
const AUTH_ROUTES = {
  [`${AUTH}/organizations/me/`]: [{ uuid: "org-1", name: "Acme" }],
  [`${AUTH}/organizations/me/org-1/applications/`]: [{ uuid: "app-1", name: "Acme (sandbox)", mode: "sandbox" }],
};

/** Stub every call: the auth lookups the server does first, then `handler(n)` for
 * the n-th verification-API call. Only the API calls are recorded. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    if (path in AUTH_ROUTES) return json(AUTH_ROUTES[path]);
    calls.push({ path: path.replace(API, ""), method: init.method ?? "GET" });
    return handler(calls.length);
  };
  return calls;
}

async function withClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo: AUTH_INFO });
  const client = new Client({ name: "session-webhooks-test", version: "0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const delivery = (response_status) => ({
  uuid: DELIVERY,
  session_id: SESSION,
  status: "Approved",
  request_url: "https://api.acme.com/didit/webhook",
  response_status,
  request_body: JSON.stringify({ session_id: SESSION, status: "Approved", decision: "x".repeat(5000) }),
  request_header: JSON.stringify({ "X-Signature": "abc", "X-Timestamp": "1700000000", Authorization: "Bearer leak", "Content-Type": "application/json" }),
  webhook_type: "status.updated",
  created_at: "2026-09-15T10:00:00Z",
});

test("both tools are advertised: the log as read-only, the resend as a write", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const log = tools.find((t) => t.name === "didit_session_webhooks");
    const resend = tools.find((t) => t.name === "didit_session_webhook_resend");

    assert.ok(log && resend, "both tools listed");
    assert.equal(log.annotations.readOnlyHint, true);
    assert.equal(resend.annotations.readOnlyHint, false);
    assert.equal(resend.annotations.destructiveHint, false);
    assert.deepEqual(log.inputSchema.required, ["session_id"]);
    assert.equal(log.inputSchema.properties.wait_seconds.maximum, 60);
  });
});

test("didit_session_webhooks reads GET /session/{id}/webhooks/ once when wait_seconds is 0", async () => {
  const calls = stubFetch(() => json([delivery(200)]));
  const res = await withClient((client) => client.callTool({ name: "didit_session_webhooks", arguments: { session_id: SESSION } }));
  const body = JSON.parse(res.content[0].text);

  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`GET /session/${SESSION}/webhooks/`]);
  assert.equal(body.deliveries.length, 1);
  assert.equal(body.deliveries[0].response_status, 200);
  assert.equal(body.waited_seconds, 0);
});

test("with wait_seconds it polls until a delivery shows up", async () => {
  const calls = stubFetch((n) => json(n < 3 ? [] : [delivery(401)]));
  const res = await withClient((client) =>
    client.callTool({ name: "didit_session_webhooks", arguments: { session_id: SESSION, wait_seconds: 5 } }),
  );
  const body = JSON.parse(res.content[0].text);

  assert.equal(calls.length, 3, "two empty reads, then the delivery");
  assert.equal(body.deliveries[0].response_status, 401);
});

test("an endpoint that never gets the event yields an empty list after the wait, not an error", async () => {
  const calls = stubFetch(() => json([]));
  const res = await withClient((client) =>
    client.callTool({ name: "didit_session_webhooks", arguments: { session_id: SESSION, wait_seconds: 1 } }),
  );
  const body = JSON.parse(res.content[0].text);

  assert.equal(res.isError, undefined);
  assert.deepEqual(body.deliveries, []);
  assert.ok(calls.length >= 1);
});

test("the delivery is compacted: body capped, only the signing headers kept", () => {
  const out = compactWebhookDelivery(delivery(200));

  assert.deepEqual(compactWebhookDelivery({ ...delivery(200), request_header: "null" }).request_headers, {});
  assert.ok(out.request_body.length < 2200 && out.request_body.endsWith("[truncated]"));
  assert.deepEqual(out.request_headers, { "X-Signature": "abc", "X-Timestamp": "1700000000" });
  assert.equal("request_header" in out, false);
  assert.equal(out.webhook_type, "status.updated");
});

test("didit_session_webhook_resend POSTs the slash-less resend route and returns the new delivery", async () => {
  const calls = stubFetch(() => json(delivery(200)));
  const res = await withClient((client) =>
    client.callTool({ name: "didit_session_webhook_resend", arguments: { session_id: SESSION, webhook_id: DELIVERY } }),
  );
  const body = JSON.parse(res.content[0].text);

  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /session/${SESSION}/webhook/${DELIVERY}/resend`]);
  assert.equal(body.response_status, 200);
});
