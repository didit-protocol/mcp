import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requestContext } from "../dist/config.js";
import { createServer } from "../dist/index.js";
import {
  backtestTransactionRule,
  createTransactionRule,
  deleteTransactionRule,
  getTransactionRule,
  installTransactionRuleLibrary,
  listTransactionRuleLibrary,
  listTransactionRules,
  uninstallTransactionRuleLibrary,
  updateTransactionRule,
} from "../dist/tools/transactions.js";

const API = "https://verification.didit.me/v3";
const APP_BASE = `${API}/organization/org-1/application/app-1/transactions/rules`;
const CTX = { accessToken: "token-1", organizationId: "org-1", applicationId: "app-1" };

const inApp = (fn) => requestContext.run(CTX, fn);

function captureRequest(responseBody = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

test("rule handlers use the org/app console contract with exact methods and payloads", async () => {
  const cases = [
    {
      run: () => listTransactionRules({ mode: "TEST", ordering: "-created_at,title" }),
      path: `${APP_BASE}/?mode=TEST&ordering=-created_at%2Ctitle`,
      method: "GET",
    },
    {
      run: () => getTransactionRule("rule-1"),
      path: `${APP_BASE}/rule-1/`,
      method: "GET",
    },
    {
      run: () => createTransactionRule({ title: "Velocity", mode: "TEST" }),
      path: `${APP_BASE}/`,
      method: "POST",
      body: { title: "Velocity", mode: "TEST" },
    },
    {
      run: () => updateTransactionRule("rule-1", { mode: "ACTIVE" }),
      path: `${APP_BASE}/rule-1/`,
      method: "PATCH",
      body: { mode: "ACTIVE" },
    },
    {
      run: () => deleteTransactionRule("rule-1"),
      path: `${APP_BASE}/rule-1/`,
      method: "DELETE",
    },
    {
      run: () => backtestTransactionRule({ conditions: [], aggregation: [], period_days: 30 }),
      path: `${APP_BASE}/backtest/`,
      method: "POST",
      body: { conditions: [], aggregation: [], period_days: 30 },
    },
    {
      run: () => listTransactionRuleLibrary({ bundle: "aml" }),
      path: `${APP_BASE}/library/?bundle=aml`,
      method: "GET",
    },
    {
      run: () => installTransactionRuleLibrary({ library_keys: ["structuring-inbound"] }),
      path: `${APP_BASE}/install/`,
      method: "POST",
      body: { library_keys: ["structuring-inbound"] },
    },
    {
      run: () => uninstallTransactionRuleLibrary({ bundle: "aml" }),
      path: `${APP_BASE}/install/`,
      method: "DELETE",
      body: { bundle: "aml" },
    },
  ];

  for (const contract of cases) {
    const calls = captureRequest();
    await inApp(contract.run);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, contract.path);
    assert.equal(calls[0].method, contract.method);
    assert.deepEqual(calls[0].body, contract.body);
  }
});

test("rule UUIDs are guarded before they enter a request path", async () => {
  await assert.rejects(
    inApp(() => getTransactionRule("../billing")),
    (error) => error?.shape?.code === "bad_request" && error?.shape?.field === "rule_uuid",
  );
});

async function listAdvertisedTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "transaction-rule-contract-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test("all nine rule tools are advertised with safe annotations and persistence guidance", async () => {
  const tools = await listAdvertisedTools();
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
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const name of names) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} missing from tools/list`);
    assert.equal(tool._meta?.["anthropic/toolGroup"], "Transactions (AML)");
  }

  assert.equal(byName.get("didit_transaction_rule_backtest").annotations.readOnlyHint, true);
  assert.equal(byName.get("didit_transaction_rule_delete").annotations.destructiveHint, true);
  assert.equal(byName.get("didit_transaction_rule_uninstall").annotations.destructiveHint, true);
  assert.equal(byName.get("didit_transaction_rule_install").annotations.destructiveHint, false);

  const create = byName.get("didit_transaction_rule_create");
  assert.match(create.description, /entire requested persisted rule/i);
  // Optional `actions` let the model omit the outcome the user asked for while
  // narrating it as saved ("goes to review" persisted as actions: []) — 2/2 on
  // gemini, 2026-09-01. Required forces an explicit decision; [] stays legal
  // for deliberate monitor-only rules.
  assert.ok(create.inputSchema.required.includes("actions"), "create must require actions");
  assert.match(create.description, /pass \[\] ONLY when the user explicitly wants a monitor-only rule/);
  assert.match(create.inputSchema.properties.aggregation.description, /create\/update/i);
  assert.match(create.inputSchema.properties.actions.description, /backtest never saves actions/i);
  assert.ok(
    create.inputSchema.properties.aggregation.items.required.includes("window"),
    "aggregation window must be explicit instead of silently defaulting to 1d",
  );

  const backtest = byName.get("didit_transaction_rule_backtest");
  assert.equal(backtest.inputSchema.properties.rule_uuid, undefined);
  assert.equal(backtest.inputSchema.properties.period_days.minimum, 1);
  assert.equal(backtest.inputSchema.properties.period_days.maximum, 365);

  for (const name of ["didit_transaction_rule_install", "didit_transaction_rule_uninstall"]) {
    assert.deepEqual(byName.get(name).inputSchema.anyOf, [
      { required: ["library_keys"] },
      { required: ["bundle"] },
    ]);
  }
});
