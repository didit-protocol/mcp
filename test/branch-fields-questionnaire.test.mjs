import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// didit_workflow_get_branch_fields never told the backend WHICH questionnaire to
// read, so a branch after a QUESTIONNAIRE node only ever saw `questionnaire.status`
// (Approved/Declined/In Review). WorkflowBranchFieldsView reads `questionnaire_uuid` from the
// POST body (service-didit-verification src/applications/views/workflow_graph.py:257); only
// then does it resolve the questions (line 298), which
// get_available_fields_for_branch_context turns into `questionnaire.answers.<question_id>`
// fields (src/applications/config/workflow_field_definitions.py:2654). Without the parameter
// the Copilot concluded that branching on a questionnaire answer was impossible.
//
// The stub below mirrors that backend contract: answer fields exist only when the request
// names the questionnaire, exactly as the real view behaves.

delete process.env.DIDIT_ACCESS_TOKEN;

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";
const ORG = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const SETTINGS = "33333333-3333-4333-8333-333333333333";
const QN = "7d0f0b0e-0000-4000-8000-00000000c0de";
const QN_OTHER = "9a1e2c3d-0000-4000-8000-00000000beef";
const TOKEN = "branch-fields-questionnaire-test";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** start → QUESTIONNAIRE → branch, the shape the customer built to route by account country. */
const graphWith = (...questionnaireUuids) => {
  const nodes = {};
  let previous;
  questionnaireUuids.forEach((uuid, index) => {
    const id = `questionnaire_${index + 1}`;
    nodes[id] = { node_type: "feature", feature: "QUESTIONNAIRE", config: { questionnaire_uuid: uuid }, next: null };
    if (previous) nodes[previous].next = id;
    previous = id;
  });
  nodes[previous].next = "branch_country";
  nodes.branch_country = { node_type: "branch", branches: [] };
  return { start_node: `questionnaire_1`, nodes };
};

const ANSWER_FIELD = {
  field: "questionnaire.answers.account_country",
  field_type: "enum",
  label: "Account country",
  description: "Answer to questionnaire question: Account country",
  operators: ["equals", "not_equals", "in", "not_in"],
  enum_values: [
    { value: "AR", label: "Argentina" },
    { value: "BR", label: "Brazil" },
    { value: "MX", label: "Mexico" },
    { value: "CO", label: "Colombia" },
  ],
  feature: "QUESTIONNAIRE",
  source_node_id: "questionnaire_1",
  qualified_field: "questionnaire.answers.account_country",
};

/** The backend only generates answer fields when the request names the questionnaire. */
function stubBackend({ completedFeatures = ["QUESTIONNAIRE"] } = {}) {
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method ?? "GET", body });

    if (path === `${AUTH}/organizations/me/`) return json([{ uuid: ORG, name: "Org One" }]);
    if (path === `${AUTH}/organizations/me/${ORG}/applications/`) return json([{ uuid: APP, name: "App One" }]);
    if (path === `${API}/organization/${ORG}/application/${APP}/verification-settings/`) {
      return json({ results: [{ uuid: SETTINGS, workflow_id: "stable-1", workflow_label: "KYC AR/BR/MX/CO" }] });
    }
    if (path.endsWith("/workflow-graph/branch-fields/")) {
      return json({
        fields: [
          { field: "questionnaire.status", field_type: "status", label: "Questionnaire Status", operators: ["equals"] },
          ...(body?.questionnaire_uuid === QN && completedFeatures.includes("QUESTIONNAIRE") ? [ANSWER_FIELD] : []),
        ],
        completed_features: completedFeatures,
        feature_node_ids: { QUESTIONNAIRE: ["questionnaire_1"] },
      });
    }
    return json({ detail: "Not found." }, 404);
  };

  return calls;
}

async function withClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (msg, extra) =>
    onmessage?.(msg, {
      ...extra,
      authInfo: { token: TOKEN, clientId: "test", scopes: ["didit:management"], extra: { organization_id: ORG } },
    });
  const client = new Client({ name: "branch-fields-questionnaire-test", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const answerFields = (result) =>
  (result.fields ?? []).map((field) => field.field).filter((field) => String(field).startsWith("questionnaire.answers."));

async function callBranchFields(args) {
  return withClient(async (client) => {
    const result = await client.callTool({
      name: "didit_workflow_get_branch_fields",
      arguments: { organization_id: ORG, application_id: APP, workflow_id: SETTINGS, ...args },
    });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  });
}

test("the tool advertises questionnaire_uuid so a QUESTIONNAIRE node can offer answers.*", async () => {
  const tools = await withClient(async (client) => (await client.listTools()).tools);
  const schema = tools.find((tool) => tool.name === "didit_workflow_get_branch_fields").inputSchema;
  const property = schema.properties.questionnaire_uuid;

  assert.ok(property, "didit_workflow_get_branch_fields has no questionnaire_uuid parameter");
  assert.match(property.description, /QUESTIONNAIRE/);
  assert.match(property.description, /questionnaire\.answers/);
  assert.equal(schema.required.includes("questionnaire_uuid"), false, "it is optional: graphs without a questionnaire must not need it");
});

test("the questionnaire_uuid the agent passes is posted, and the answers.* fields come back", async () => {
  const calls = stubBackend();
  const result = await callBranchFields({ graph: graphWith(QN), branch_node_id: "branch_country", questionnaire_uuid: QN });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, QN, "the backend cannot resolve the questions without it");
  assert.deepEqual(answerFields(result), ["questionnaire.answers.account_country"]);
});

test("a graph that names one questionnaire resolves it, so the agent need not infer the uuid", async () => {
  const calls = stubBackend();
  const result = await callBranchFields({ graph: graphWith(QN), branch_node_id: "branch_country" });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, QN, "the QUESTIONNAIRE node's config names it");
  assert.deepEqual(answerFields(result), ["questionnaire.answers.account_country"]);
});

test("a uuid this application cannot read says so, instead of looking like answer branching is unsupported", async () => {
  const calls = stubBackend();
  const result = await callBranchFields({ graph: graphWith(QN_OTHER), branch_node_id: "branch_country", questionnaire_uuid: QN_OTHER });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, QN_OTHER, "the agent's choice is posted as given");
  assert.deepEqual(answerFields(result), []);
  assert.match(String(result.note), /no questionnaire\.answers\.\* fields came back/);
  assert.match(String(result.note), /branchable questions/);
});

test("two questionnaire nodes with different uuids are not guessed; the answer says to choose one", async () => {
  const calls = stubBackend();
  const result = await callBranchFields({ graph: graphWith(QN, QN_OTHER), branch_node_id: "branch_country" });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, undefined, "picking one arbitrarily would describe the wrong questionnaire's answers");
  assert.deepEqual(answerFields(result), []);
  assert.match(String(result.note), /questionnaire_uuid/, "the agent must be told how to choose, not left with a missing field");
  assert.match(String(result.note), /(more than one|several|multiple|different|ambiguous)/i);
});

test("a questionnaire that does not complete on every path says why its answers are missing", async () => {
  // The backend derives completed features from the graph: one QUESTIONNAIRE on a single path that
  // reaches the branch does not complete there, so it answers with status only — the same shape
  // the customer read as "branching on an answer is impossible".
  const calls = stubBackend({ completedFeatures: [] });
  const result = await callBranchFields({ graph: graphWith(QN), branch_node_id: "branch_country" });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, QN, "the resolved uuid is still sent");
  assert.deepEqual(answerFields(result), []);
  assert.match(String(result.note), /no QUESTIONNAIRE node completes on every path/);
  assert.match(String(result.note), /questionnaire\.answers\.\* fields are not offered/, "the note points at the missing fields");
});

test("a questionnaire node that names no uuid is not guessed: the answer says to pass one", async () => {
  const graph = graphWith(QN);
  delete graph.nodes.questionnaire_1.config.questionnaire_uuid;
  const calls = stubBackend();
  const result = await callBranchFields({ graph, branch_node_id: "branch_country" });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, undefined, "an unnamed questionnaire has no uuid to send");
  assert.deepEqual(answerFields(result), []);
  assert.match(String(result.note), /does not name its uuid/);
  assert.match(String(result.note), /Pass questionnaire_uuid/);
});

test("one named questionnaire next to an unnamed one is not guessed either", async () => {
  // The unnamed node may run a different form: sending the named uuid would describe the wrong questions.
  const graph = graphWith(QN, QN_OTHER);
  delete graph.nodes.questionnaire_2.config.questionnaire_uuid;
  const calls = stubBackend();
  const result = await callBranchFields({ graph, branch_node_id: "branch_country" });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, undefined);
  assert.deepEqual(answerFields(result), []);
  assert.match(String(result.note), /does not name its uuid/);
  assert.match(String(result.note), /Pass questionnaire_uuid/);
});

test("a questionnaire node nothing leads to does not make the graph ambiguous", async () => {
  const graph = graphWith(QN);
  graph.nodes.orphan = { node_type: "feature", feature: "QUESTIONNAIRE", config: { questionnaire_uuid: QN_OTHER }, next: "branch_country" };
  const calls = stubBackend();
  const result = await callBranchFields({ graph, branch_node_id: "branch_country" });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, QN, "only the questionnaire on a path from start_node counts");
  assert.deepEqual(answerFields(result), ["questionnaire.answers.account_country"]);
  assert.equal(result.note, undefined);
});

test("a questionnaire that only runs after the branch, on a loop back to it, is not counted", async () => {
  const graph = graphWith(QN);
  graph.nodes.branch_country.branches = [{ id: "retry", rules: [], goto: "questionnaire_later" }];
  graph.nodes.questionnaire_later = { node_type: "feature", feature: "QUESTIONNAIRE", config: { questionnaire_uuid: QN_OTHER }, next: "branch_country" };
  const calls = stubBackend();
  const result = await callBranchFields({ graph, branch_node_id: "branch_country" });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, QN);
  assert.equal(result.note, undefined);
});

test("a graph with no usable start_node still resolves its single questionnaire", async () => {
  const graph = graphWith(QN);
  graph.start_node = "not_a_node";
  const calls = stubBackend();
  await callBranchFields({ graph, branch_node_id: "branch_country" });

  const post = calls.find((call) => call.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.body.questionnaire_uuid, QN, "the backend, not this walk, judges the start node");
});
