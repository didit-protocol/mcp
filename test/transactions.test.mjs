import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { TRANSACTION_TOOLS } from "../dist/tools/transactions.js";

// The transaction tools against the console routes of the verification API (applications/urls.py
// transactions/…): the list's real filters, what a wallet screening takes, and a transaction's notes.

delete process.env.DIDIT_ACCESS_TOKEN;

const APP_BASE = "https://verification.didit.me/v3/organization/org-1/application/app-1";
const TRANSACTION = "4c3b2a19-8f7e-4d6c-9b5a-0e1f2a3b4c5d";
const TOOLS = new Map(TRANSACTION_TOOLS.map((tool) => [tool.def.name, tool]));

function recordFetch(t, reply = () => ({})) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const parsed = new URL(String(url));
    const sent = { method: init.method ?? "GET", path: `${parsed.origin}${parsed.pathname}`, query: Object.fromEntries(parsed.searchParams), body: init.body && JSON.parse(init.body) };
    calls.push(sent);
    const answer = reply(sent);
    return answer instanceof Response ? answer : Response.json(answer);
  });
  return calls;
}

const call = async (name, args) =>
  requestContext.run({ accessToken: "token-1", organizationId: "org-1", applicationId: "app-1" }, () => TOOLS.get(name).run(args));

// service-didit-verification applications/services/transaction_filters.py, TRANSACTION_LIST_FILTER_FIELDS.
const BACKEND_FILTERS = [
  "flagged", "rule", "assignee", "score_min", "score_max", "search", "status", "direction", "currency", "country",
  "action_type", "transaction_type", "severity", "amount_min", "amount_max", "start_date", "end_date", "txn_id",
  "didit_id", "vendor_data", "travel_rule_status",
];

test("the transaction list offers the filters the API reads, and sends them as they are", async (t) => {
  const calls = recordFetch(t, () => ({ count: 0, results: [] }));
  const { properties } = TOOLS.get("didit_transaction_list").def.inputSchema;
  const offered = Object.keys(properties).filter((key) => !["organization_id", "application_id", "limit", "offset"].includes(key));
  assert.deepEqual(offered.sort(), [...BACKEND_FILTERS].sort());

  await call("didit_transaction_list", { status: "IN_REVIEW,DECLINED", flagged: true, start_date: "2026-11-01", limit: "5" });
  assert.deepEqual(calls, [{ method: "GET", path: `${APP_BASE}/transactions/`, query: { status: "IN_REVIEW,DECLINED", flagged: "true", start_date: "2026-11-01", limit: "5" }, body: undefined }]);
});

test("a wallet is screened without naming its network, on any network the API supports", async (t) => {
  const calls = recordFetch(t);
  const { inputSchema } = TOOLS.get("didit_transaction_screen_wallet").def;
  assert.deepEqual(inputSchema.required, ["wallet_address"]);
  assert.deepEqual([...inputSchema.properties.blockchain.enum].sort(), [
    "ADA", "ARB", "AVAX", "BASE", "BCH", "BNB", "BTC", "CELO", "DOGE", "ETH", "HBAR", "LIGHTNING", "LTC", "MATIC", "MODE", "OP", "PLUME", "SOL", "TRX", "USDC", "USDT", "XLM", "XRP",
  ]);
  await call("didit_transaction_screen_wallet", { wallet_address: "bc1qexample" });
  assert.deepEqual(calls, [{ method: "POST", path: `${APP_BASE}/transactions/screen-wallet/`, query: {}, body: { wallet_address: "bc1qexample" } }]);
});

test("a transaction is read alone, or with its notes and the subject's other transactions", async (t) => {
  const calls = recordFetch(t, ({ path }) => (path.endsWith(`${TRANSACTION}/`) ? { uuid: TRANSACTION } : { count: 1, results: [{ path: path.split("/").at(-2) }] }));
  assert.deepEqual(await call("didit_transaction_get", { transaction_id: TRANSACTION }), { uuid: TRANSACTION });
  assert.deepEqual(calls.splice(0).map(({ path }) => path), [`${APP_BASE}/transactions/${TRANSACTION}/`]);

  const full = await call("didit_transaction_get", { transaction_id: TRANSACTION, include: ["notes", "related"] });
  assert.deepEqual(calls.map(({ path }) => path), ["", "notes/", "related/"].map((part) => `${APP_BASE}/transactions/${TRANSACTION}/${part}`));
  assert.deepEqual(Object.keys(full.included), ["notes", "related"]);

  await assert.rejects(call("didit_transaction_get", { transaction_id: TRANSACTION, include: ["webhooks"] }), (error) => error.shape.field === "include" && error.shape.allowed.length === 2);
});

test("a note is added to a transaction; a role without the permission gets the API's refusal", async (t) => {
  const calls = recordFetch(t, () => ({ uuid: "note-1" }));
  const tool = TOOLS.get("didit_transaction_note_create");
  assert.deepEqual([tool.access, tool.permission], ["write", "write:transactions"]);
  await call("didit_transaction_note_create", { transaction_id: TRANSACTION, note: "Called the customer", mentioned_emails: ["ana@example.com"] });
  assert.deepEqual(calls, [
    { method: "POST", path: `${APP_BASE}/transactions/${TRANSACTION}/notes/`, query: {}, body: { note: "Called the customer", mentioned_emails: ["ana@example.com"] } },
  ]);
  t.mock.method(globalThis, "fetch", async () => Response.json({ detail: "You do not have permission to perform this action." }, { status: 403 }));
  await assert.rejects(call("didit_transaction_note_create", { transaction_id: TRANSACTION, note: "x" }), (error) => error.shape.status === 403);
});
