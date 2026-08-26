import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listTransactionRules,
  getTransactionRule,
  createTransactionRule,
  updateTransactionRule,
  deleteTransactionRule,
  backtestTransactionRule,
  listTransactionRuleLibrary,
  installTransactionRuleLibrary,
  uninstallTransactionRuleLibrary,
} from "../dist/tools/transactions.js";
import { requestContext } from "../dist/config.js";
import { DiditError } from "../dist/security.js";
import { handleModernRpc } from "../dist/mcp-modern.js";

// Transaction-monitoring (KYT) rules — org/app-scoped console resource
// (/organization/{org}/application/{app}/transactions/rules...). See rule-api-contract.md.

const API = "https://verification.didit.me/v3";
const BASE = `${API}/organization/org-1/application/app-1/transactions/rules`;
const CTX = { accessToken: "t-1", organizationId: "org-1", applicationId: "app-1" };

/** Capture the wire request instead of calling the real API. */
function stubFetch(responseBody = {}, status = 200) {
  const sent = { calls: [] };
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    sent.calls.push(call);
    Object.assign(sent, call);
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return sent;
}

// ── list ──────────────────────────────────────────────────────────────────

test("listTransactionRules: GET rules/ with filters as query params", async () => {
  const sent = stubFetch({ count: 0, results: [] });
  await requestContext.run(CTX, () =>
    listTransactionRules({ source: "CUSTOM", mode: "ACTIVE", category: "aml_ctf", limit: "10", offset: "0" }),
  );
  assert.equal(sent.method, "GET");
  assert.equal(sent.body, undefined);
  const url = new URL(sent.url);
  assert.equal(url.origin + url.pathname, `${BASE}/`);
  assert.equal(url.searchParams.get("source"), "CUSTOM");
  assert.equal(url.searchParams.get("mode"), "ACTIVE");
  assert.equal(url.searchParams.get("category"), "aml_ctf");
  assert.equal(url.searchParams.get("limit"), "10");
});

// ── get ───────────────────────────────────────────────────────────────────

test("getTransactionRule: GET rules/{uuid}/", async () => {
  const sent = stubFetch({ uuid: "rule-1" });
  await requestContext.run(CTX, () => getTransactionRule("rule-1"));
  assert.equal(sent.method, "GET");
  assert.equal(sent.url, `${BASE}/rule-1/`);
});

test("getTransactionRule: missing rule_uuid rejects before any request", async () => {
  stubFetch();
  await assert.rejects(
    requestContext.run(CTX, () => getTransactionRule(undefined)),
    DiditError,
  );
});

// ── create ────────────────────────────────────────────────────────────────

test("createTransactionRule: POST rules/ with the full payload verbatim", async () => {
  const sent = stubFetch({ uuid: "rule-new" }, 201);
  const conditions = [
    { field: "amount", operator: "gte", value: 10000 },
    { field: "subject_country", operator: "in", value: ["IRN", "PRK"] },
  ];
  const aggregation = [
    { metric: "count", operator: "gt", value: 5, window: "1h", filters: { subject_vendor_data: "__current__" } },
  ];
  const actions = [
    { type: "add_score", value: 30 },
    { type: "change_status", value: "AWAITING_USER", workflow_id: "wf-1" },
  ];
  await requestContext.run(CTX, () =>
    createTransactionRule({
      title: "High-risk corridor",
      category: "aml_ctf",
      mode: "TEST",
      evaluation_mode: "ALL",
      scope: { transaction_types: ["finance"], directions: ["OUTBOUND"] },
      conditions,
      aggregation,
      actions,
      metadata: { owner: "compliance" },
    }),
  );
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, `${BASE}/`);
  assert.equal(sent.body.title, "High-risk corridor");
  assert.equal(sent.body.category, "aml_ctf");
  assert.equal(sent.body.mode, "TEST");
  assert.deepEqual(sent.body.conditions, conditions);
  assert.deepEqual(sent.body.aggregation, aggregation);
  assert.deepEqual(sent.body.actions, actions);
  assert.deepEqual(sent.body.scope, { transaction_types: ["finance"], directions: ["OUTBOUND"] });
});

// ── update ────────────────────────────────────────────────────────────────

test("updateTransactionRule: PATCH rules/{uuid}/ with only the changed fields", async () => {
  const sent = stubFetch({ uuid: "rule-1", mode: "ACTIVE" });
  await requestContext.run(CTX, () => updateTransactionRule("rule-1", { mode: "ACTIVE" }));
  assert.equal(sent.method, "PATCH");
  assert.equal(sent.url, `${BASE}/rule-1/`);
  assert.deepEqual(sent.body, { mode: "ACTIVE" });
});

test("updateTransactionRule: missing rule_uuid rejects before any request", async () => {
  stubFetch();
  await assert.rejects(
    requestContext.run(CTX, () => updateTransactionRule("", { mode: "ACTIVE" })),
    DiditError,
  );
});

// ── delete ────────────────────────────────────────────────────────────────

test("deleteTransactionRule: DELETE rules/{uuid}/, no body", async () => {
  const sent = stubFetch({ success: true });
  await requestContext.run(CTX, () => deleteTransactionRule("rule-1"));
  assert.equal(sent.method, "DELETE");
  assert.equal(sent.url, `${BASE}/rule-1/`);
  assert.equal(sent.body, undefined);
});

test("deleteTransactionRule: missing rule_uuid rejects before any request", async () => {
  stubFetch();
  await assert.rejects(
    requestContext.run(CTX, () => deleteTransactionRule(undefined)),
    DiditError,
  );
});

// ── backtest ──────────────────────────────────────────────────────────────

test("backtestTransactionRule: POST rules/backtest/ with the candidate shape", async () => {
  const sent = stubFetch({ evaluated: 100, matched: 4, affected_entities: 3, period_days: 30 });
  const conditions = [{ field: "amount", operator: "gt", value: 5000 }];
  await requestContext.run(CTX, () =>
    backtestTransactionRule({ conditions, evaluation_mode: "ALL", period_days: 30 }),
  );
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, `${BASE}/backtest/`);
  assert.deepEqual(sent.body.conditions, conditions);
  assert.equal(sent.body.period_days, 30);
});

// ── library list ──────────────────────────────────────────────────────────

test("listTransactionRuleLibrary: GET rules/library/ with filters as query params", async () => {
  const sent = stubFetch({ count: 0, results: [] });
  await requestContext.run(CTX, () => listTransactionRuleLibrary({ bundle: "fatf-basics", search: "velocity" }));
  assert.equal(sent.method, "GET");
  const url = new URL(sent.url);
  assert.equal(url.origin + url.pathname, `${BASE}/library/`);
  assert.equal(url.searchParams.get("bundle"), "fatf-basics");
  assert.equal(url.searchParams.get("search"), "velocity");
});

// ── install / uninstall ──────────────────────────────────────────────────

test("installTransactionRuleLibrary: POST rules/install/ with library_keys", async () => {
  const sent = stubFetch({ installed_library_keys: ["k1"], installed_count: 1 });
  await requestContext.run(CTX, () => installTransactionRuleLibrary({ library_keys: ["k1"] }));
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, `${BASE}/install/`);
  assert.deepEqual(sent.body, { library_keys: ["k1"] });
});

test("installTransactionRuleLibrary: POST rules/install/ with bundle", async () => {
  const sent = stubFetch({ installed_library_keys: ["k1", "k2"], installed_count: 2 });
  await requestContext.run(CTX, () => installTransactionRuleLibrary({ bundle: "fatf-basics" }));
  assert.equal(sent.method, "POST");
  assert.deepEqual(sent.body, { bundle: "fatf-basics" });
});

test("uninstallTransactionRuleLibrary: DELETE rules/install/ carrying a JSON body", async () => {
  const sent = stubFetch({ uninstalled_count: 1 });
  await requestContext.run(CTX, () => uninstallTransactionRuleLibrary({ library_keys: ["k1"] }));
  assert.equal(sent.method, "DELETE");
  assert.equal(sent.url, `${BASE}/install/`);
  assert.deepEqual(sent.body, { library_keys: ["k1"] });
});

test("uninstallTransactionRuleLibrary: DELETE rules/install/ with bundle", async () => {
  const sent = stubFetch({ uninstalled_count: 3 });
  await requestContext.run(CTX, () => uninstallTransactionRuleLibrary({ bundle: "fatf-basics" }));
  assert.equal(sent.method, "DELETE");
  assert.deepEqual(sent.body, { bundle: "fatf-basics" });
});

// ── MCP tool annotations (readOnlyHint / destructiveHint) ──────────────────

test("annotations: delete and uninstall are destructive; list/get/library_list are read-only", async () => {
  const reply = await handleModernRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const byName = Object.fromEntries(reply.result.tools.map((t) => [t.name, t]));

  const names = [
    "didit_transaction_rule_list",
    "didit_transaction_rule_get",
    "didit_transaction_rule_create",
    "didit_transaction_rule_update",
    "didit_transaction_rule_delete",
    "didit_transaction_rule_backtest",
    "didit_transaction_rule_library_list",
    "didit_transaction_rule_install",
    "didit_transaction_rule_uninstall",
  ];
  for (const name of names) {
    assert.ok(byName[name], `${name} missing from tools/list`);
    assert.equal(byName[name]._meta["anthropic/toolGroup"], "Transactions (AML)");
  }

  assert.equal(byName.didit_transaction_rule_delete.annotations.destructiveHint, true);
  assert.equal(byName.didit_transaction_rule_uninstall.annotations.destructiveHint, true);

  assert.equal(byName.didit_transaction_rule_list.annotations.readOnlyHint, true);
  assert.equal(byName.didit_transaction_rule_get.annotations.readOnlyHint, true);
  assert.equal(byName.didit_transaction_rule_library_list.annotations.readOnlyHint, true);

  assert.equal(byName.didit_transaction_rule_list.annotations.destructiveHint, false);
  assert.equal(byName.didit_transaction_rule_get.annotations.destructiveHint, false);
  assert.equal(byName.didit_transaction_rule_create.annotations.destructiveHint, false);
  assert.equal(byName.didit_transaction_rule_update.annotations.destructiveHint, false);
});
