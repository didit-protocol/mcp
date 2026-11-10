import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// What a coding agent can do about billing on each surface (agent friction audit, 9 Nov 2026).
// The hosted connector never creates a payment page: the person pays in the console through the
// links the billing tools return. A local stdio server is the person's own setup and keeps
// didit_org_top_up, also when it was started with DIDIT_ACCESS_TOKEN.

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;

const BILLING_TOOLS = [
  "didit_billing_get_plan",
  "didit_billing_quote_plan",
  "didit_billing_list_payment_methods",
  "didit_billing_list_receipts",
  "didit_billing_get_details",
  "didit_billing_update_details",
];
const HOSTED_USER = { token: "user-bearer", clientId: "test", scopes: ["didit:management"], extra: { organization_id: "org-1" } };

async function withClient({ hosted = false, authInfo } = {}, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(hosted ? { hosted: true } : {});
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo });
  }
  const client = new Client({ name: "agent-billing-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("the hosted catalog offers the billing tools and no payment tool", async () => {
  const tools = await withClient({ hosted: true, authInfo: HOSTED_USER }, async (c) => (await c.listTools()).tools);
  const names = tools.map((t) => t.name);
  for (const name of BILLING_TOOLS) assert.ok(names.includes(name), `${name} missing from the hosted catalog`);
  assert.ok(!names.includes("didit_org_top_up"));
  const readOnly = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
  for (const name of BILLING_TOOLS.filter((n) => n !== "didit_billing_update_details")) {
    assert.equal(readOnly[name], true, `${name} must be read-only`);
  }
  assert.equal(readOnly.didit_billing_update_details, false);
});

test("a hosted call to the unlisted top-up tool is refused with the console route", async () => {
  let fetched = false;
  globalThis.fetch = async (url) => {
    // The only call allowed is the best-effort signed request link (no payment, no money).
    if (String(url).includes("/billing/top-up-requests/")) return new Response("{}", { status: 500 });
    fetched = true;
    return new Response("{}", { status: 200 });
  };
  const result = await withClient({ hosted: true, authInfo: HOSTED_USER }, (c) =>
    c.callTool({ name: "didit_org_top_up", arguments: { amount_in_dollars: 100, confirm: true } }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /next_steps\.top_up_url/);
  assert.equal(fetched, false);
});

test("a local stdio server started with DIDIT_ACCESS_TOKEN keeps didit_org_top_up", async () => {
  process.env.DIDIT_ACCESS_TOKEN = "local-token";
  try {
    const names = await withClient({}, async (c) => (await c.listTools()).tools.map((t) => t.name));
    assert.ok(names.includes("didit_org_top_up"));
    for (const name of BILLING_TOOLS) assert.ok(names.includes(name), `${name} missing from stdio`);
  } finally {
    delete process.env.DIDIT_ACCESS_TOKEN;
  }
});

test("didit_billing_update_details with an explicit organization_id updates that organization", async () => {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ legal_name: "Acme", address: {}, billing_emails: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const result = await withClient({ hosted: true, authInfo: HOSTED_USER }, (c) =>
    c.callTool({ name: "didit_billing_update_details", arguments: { organization_id: "org-2", po_number: "PO-7" } }),
  );
  assert.equal(result.isError, undefined);
  const put = seen.find((call) => call.method === "PUT");
  assert.match(put.url, /\/organization\/org-2\/billing\/details\/$/);
  assert.equal(put.body.po_number, "PO-7");
  assert.equal("organization_id" in put.body, false);
});
