import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";

// The Investigator tools call the /v3 client API with the user's Bearer and the org/app in
// headers. Its decisions (accept, override, batch accept) and policy answers are human
// decisions: annotated destructive, worded as needing approval, refused without confirm:true.

const API = "https://verification.didit.me/v3";
const ORG = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const QUESTION = "44444444-4444-4444-8444-444444444444";

const DECISION_TOOLS = [
  "didit_investigator_accept",
  "didit_investigator_override",
  "didit_investigator_batch_accept",
  "didit_investigator_question_answer",
  "didit_investigator_question_dismiss",
  "didit_investigator_rereview",
];
const READ_TOOLS = [
  "didit_investigator_queue_list",
  "didit_investigator_report_get",
  "didit_investigator_question_list",
  "didit_investigator_question_get",
  "didit_investigator_backtest_get",
  "didit_investigator_performance_get",
  "didit_investigator_dashboard_get",
  "didit_investigator_activity_list",
  "didit_investigator_record_get",
];

delete process.env.DIDIT_ACCESS_TOKEN;

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

async function withClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "investigator-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const scoped = (args) => ({ organization_id: ORG, application_id: APP, ...args });

test("decision tools are destructive, say they need human approval and schema-require confirm", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    for (const name of DECISION_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.equal(tool.annotations.destructiveHint, true, name);
      assert.equal(tool.annotations.readOnlyHint, false, name);
      assert.match(tool.description, /Requires human approval/, name);
      assert.equal(tool.inputSchema.properties.confirm.type, "boolean", name);
      assert.match(tool.inputSchema.properties.confirm.description, /explicit user confirmation of this exact action/);
      assert.ok(tool.inputSchema.required.includes("confirm"), name);
    }
    for (const name of READ_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.equal(tool.annotations.readOnlyHint, true, name);
      assert.ok("organization_id" in tool.inputSchema.properties && "application_id" in tool.inputSchema.properties);
    }
    const backtest = tools.find((t) => t.name === "didit_investigator_backtest_start");
    assert.equal(backtest.annotations.readOnlyHint, false, "a backtest is stored: not read-only");
    assert.equal(backtest.annotations.destructiveHint, false);
  });
});

test("every Investigator tool has a permission entry", async () => {
  await withClient(async (client) => {
    const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("didit_investigator_"));
    assert.equal(names.length, 17);
    for (const name of names) assert.ok(name in TOOL_PERMISSIONS, name);
    assert.equal(TOOL_PERMISSIONS.didit_investigator_backtest_start, "write:applications");
  });
});

test("decisions without confirm:true are refused before any request", async () => {
  const calls = stubFetch();
  await withClient(async (client) => {
    for (const call of [
      { name: "didit_investigator_accept", arguments: scoped({ run_id: RUN }) },
      { name: "didit_investigator_accept", arguments: scoped({ run_id: RUN, confirm: false }) },
      {
        name: "didit_investigator_override",
        arguments: scoped({ run_id: RUN, action: "decline", category: "other", reason: "Address does not match." }),
      },
      { name: "didit_investigator_batch_accept", arguments: scoped({ run_ids: [RUN] }) },
      { name: "didit_investigator_question_answer", arguments: scoped({ question_id: QUESTION, answer: "person" }) },
      { name: "didit_investigator_question_dismiss", arguments: scoped({ question_id: QUESTION }) },
      { name: "didit_investigator_rereview", arguments: scoped({ run_id: RUN, note: "Salary payment." }) },
    ]) {
      const res = await client.callTool(call);
      assert.equal(res.isError, true, `${call.name} must refuse without confirm:true`);
      assert.match(res.content[0].text, /confirm/i);
    }
  });
  assert.equal(calls.length, 0);
});

test("confirmed decisions hit /v3/investigator with the org/app headers and only the payload", async () => {
  const calls = stubFetch();
  await withClient(async (client) => {
    await client.callTool({
      name: "didit_investigator_accept",
      arguments: scoped({ run_id: RUN, narrative: "Checked.", confirm: true }),
    });
    await client.callTool({
      name: "didit_investigator_override",
      arguments: scoped({
        run_id: RUN,
        action: "decline",
        category: "evidence_misread",
        reason: "The address on the bill is not the user's.",
        confirm: true,
      }),
    });
    await client.callTool({ name: "didit_investigator_batch_accept", arguments: scoped({ run_ids: [RUN], confirm: true }) });
    await client.callTool({
      name: "didit_investigator_question_answer",
      arguments: scoped({ question_id: QUESTION, answer: "person", confirm: true }),
    });
    await client.callTool({ name: "didit_investigator_question_dismiss", arguments: scoped({ question_id: QUESTION, confirm: true }) });
  });
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body ? JSON.parse(c.body) : undefined]),
    [
      ["POST", `${API}/investigator/runs/${RUN}/accept/`, { narrative: "Checked." }],
      [
        "POST",
        `${API}/investigator/runs/${RUN}/override/`,
        { action: "decline", category: "evidence_misread", reason: "The address on the bill is not the user's." },
      ],
      ["POST", `${API}/investigator/runs/batch-accept/`, { run_ids: [RUN] }],
      ["POST", `${API}/investigator/questions/${QUESTION}/answer/`, { answer: "person" }],
      ["POST", `${API}/investigator/questions/${QUESTION}/dismiss/`, undefined],
    ],
  );
  for (const call of calls) {
    assert.equal(call.headers["X-Didit-Organization-Id"], ORG);
    assert.equal(call.headers["X-Didit-Application-Id"], APP);
  }
});

test("reads and the free backtest route their filters", async () => {
  const calls = stubFetch();
  await withClient(async (client) => {
    await client.callTool({
      name: "didit_investigator_queue_list",
      arguments: scoped({ queue: "kyc", ready: true, recommendation: "approve", search: "" }),
    });
    await client.callTool({ name: "didit_investigator_report_get", arguments: scoped({ run_id: RUN }) });
    await client.callTool({ name: "didit_investigator_question_list", arguments: scoped({ status: "open" }) });
    await client.callTool({ name: "didit_investigator_performance_get", arguments: scoped({ period: 90 }) });
    await client.callTool({ name: "didit_investigator_activity_list", arguments: scoped({ group: "overrides", limit: 5 }) });
    await client.callTool({
      name: "didit_investigator_backtest_start",
      arguments: scoped({ queues: ["kyc"], period_days: 30 }),
    });
  });
  assert.deepEqual(
    calls.map((c) => [c.method, c.url]),
    [
      ["GET", `${API}/investigator/queue/?queue=kyc&recommendation=approve&ready=true`],
      ["GET", `${API}/investigator/runs/${RUN}/`],
      ["GET", `${API}/investigator/questions/?status=open`],
      ["GET", `${API}/investigator/performance/?period=90`],
      ["GET", `${API}/investigator/activity/?group=overrides&limit=5`],
      ["POST", `${API}/investigator/backtests/`],
    ],
  );
  assert.deepEqual(JSON.parse(calls[5].body), { queues: ["kyc"], period_days: 30 });
});

test("a batch accept over the backend's limit is refused locally", async () => {
  const calls = stubFetch();
  await withClient(async (client) => {
    const runIds = Array.from({ length: 51 }, () => RUN);
    const res = await client.callTool({ name: "didit_investigator_batch_accept", arguments: scoped({ run_ids: runIds, confirm: true }) });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /1 to 50/);
  });
  assert.equal(calls.length, 0);
});

test("add_note and rereview use the run's notes/rereview endpoints for every item kind", async () => {
  const calls = stubFetch();
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const note = tools.find((t) => t.name === "didit_investigator_add_note");
    assert.equal(note.annotations.readOnlyHint, false);
    assert.equal(note.annotations.destructiveHint, false);
    for (const name of ["didit_investigator_add_note", "didit_investigator_rereview"]) {
      assert.equal(TOOL_PERMISSIONS[name], null, name);
    }
    await client.callTool({
      name: "didit_investigator_add_note",
      arguments: scoped({ run_id: RUN, note: "  The customer sent a new utility bill.  " }),
    });
    await client.callTool({
      name: "didit_investigator_rereview",
      arguments: scoped({ run_id: RUN, note: "Salary payment, confirmed by phone.", confirm: true }),
    });
    await client.callTool({ name: "didit_investigator_rereview", arguments: scoped({ run_id: RUN, confirm: true }) });
  });
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, JSON.parse(c.body)]),
    [
      ["POST", `${API}/investigator/runs/${RUN}/notes/`, { text: "The customer sent a new utility bill." }],
      ["POST", `${API}/investigator/runs/${RUN}/rereview/`, { note: "Salary payment, confirmed by phone." }],
      ["POST", `${API}/investigator/runs/${RUN}/rereview/`, {}],
    ],
  );
});

test("an empty or too long note is refused before any request", async () => {
  const calls = stubFetch();
  await withClient(async (client) => {
    for (const args of [{ run_id: RUN, note: "   " }, { run_id: RUN, note: "x".repeat(2001) }]) {
      const res = await client.callTool({ name: "didit_investigator_add_note", arguments: scoped(args) });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /note/);
    }
    const res = await client.callTool({
      name: "didit_investigator_rereview",
      arguments: scoped({ run_id: RUN, note: "x".repeat(2001), confirm: true }),
    });
    assert.equal(res.isError, true);
  });
  assert.equal(calls.length, 0);
});

test("every Investigator call says it came through the MCP (X-Didit-Actor-Via: mcp)", async () => {
  const calls = stubFetch();
  await withClient(async (client) => {
    await client.callTool({ name: "didit_investigator_report_get", arguments: scoped({ run_id: RUN }) });
    await client.callTool({ name: "didit_investigator_accept", arguments: scoped({ run_id: RUN, confirm: true }) });
    await client.callTool({ name: "didit_investigator_add_note", arguments: scoped({ run_id: RUN, note: "Known." }) });
  });
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.headers["X-Didit-Actor-Via"], "mcp");
});

test("only an incoming X-Didit-Actor-Via of copilot is forwarded as copilot", async () => {
  const { actorViaFromHeaders } = await import("../dist/tools/investigator.js");
  assert.equal(actorViaFromHeaders({ "x-didit-actor-via": "copilot" }), "copilot");
  assert.equal(actorViaFromHeaders({ "x-didit-actor-via": " Copilot " }), "copilot");
  assert.equal(actorViaFromHeaders({ "x-didit-actor-via": ["copilot"] }), "copilot");
  assert.equal(actorViaFromHeaders({ "x-didit-actor-via": "console" }), "mcp");
  assert.equal(actorViaFromHeaders({}), "mcp");
  assert.equal(actorViaFromHeaders(undefined), "mcp");
});

test("record_get reads one verification's or transaction's newest run, and needs exactly one id", async () => {
  const calls = stubFetch();
  const SESSION = "55555555-5555-4555-8555-555555555555";
  const TRANSACTION = "66666666-6666-4666-8666-666666666666";
  await withClient(async (client) => {
    await client.callTool({ name: "didit_investigator_record_get", arguments: scoped({ session_id: SESSION }) });
    await client.callTool({ name: "didit_investigator_record_get", arguments: scoped({ transaction_id: TRANSACTION }) });
    for (const args of [{}, { session_id: SESSION, transaction_id: TRANSACTION }]) {
      const res = await client.callTool({ name: "didit_investigator_record_get", arguments: scoped(args) });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /exactly one of session_id or transaction_id/);
    }
  });
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.headers["X-Didit-Application-Id"]]),
    [
      ["GET", `${API}/investigator/sessions/${SESSION}/`, APP],
      ["GET", `${API}/investigator/transactions/${TRANSACTION}/`, APP],
    ],
  );
});
