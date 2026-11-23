import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { apiKeyAuthInfo } from "../dist/api-key-connection.js";
import { CORE_TOOLSET, parseSelection } from "../dist/toolsets.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// What a connection is given for each tool it lists. Two things were sent many times over and
// are now sent once, or not at all, without a tool or an argument a caller needs going away:
//
// - The workflow graph manual: about 26 KB of text, the `graph` argument of both the tool that
//   saves a graph and the tool that validates one. A list that has both carries it once, on
//   the saving tool.
// - The two routing ids on an API key connection: the key is one application, so no tool takes
//   organization_id or application_id there.
//
// The last test is a budget: the list is what every connection pays for on every request, so
// growing it is a decision somebody makes, not something that happens.

for (const name of ["DIDIT_ACCESS_TOKEN", "DIDIT_IS_STAFF", "DIDIT_TOOLSETS", "DIDIT_READ_ONLY", "MCP_DEFAULT_TOOLSETS"]) delete process.env[name];
process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";

const PERSON = { token: "person.access.token", clientId: "list-definitions-test", scopes: [], extra: { organization_id: "org-1" } };
const KEY = apiKeyAuthInfo(
  "k".repeat(40),
  {
    active: true,
    sub: "app-1",
    client_id: "client-of-the-application",
    organization_id: "org-1",
    organization_name: "Acme",
    application_name: "Acme (Sandbox)",
    application_mode: "sandbox",
    claims: [],
    api_key: { uuid: "key-1", label: "CI", prefix: "sk_test_9c2f", primary: false, scopes: null, allowed_ips: [], expires_at: null },
  },
  new URL(process.env.MCP_RESOURCE_URI),
);

const VALIDATE = "didit_workflow_validate_graph";
const SAVE = "didit_workflow_set_graph";
const ROUTING_IDS = ["organization_id", "application_id"];

async function withClient(options, authInfo, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  }
  const client = new Client({ name: "list-definitions-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const listed = (options, authInfo) => withClient(options, authInfo, async (client) => new Map((await client.listTools()).tools.map((tool) => [tool.name, tool])));
const graphOf = (tool) => tool.inputSchema.properties.graph;
/** The bytes of a list that reach a model: name, description and input schema of every tool. */
const definitionBytes = (tools) =>
  JSON.stringify([...tools.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))).length;

test("a list with both graph tools carries the graph manual once, and the other tool points at it", async () => {
  for (const [label, options, authInfo] of [
    ["hosted", { hosted: true }, PERSON],
    ["local", {}, undefined],
    ["API key", { hosted: true, apiKey: true }, KEY],
  ]) {
    const tools = await listed(options, authInfo);
    // The manual is on the tool that SAVES a graph: a graph built without it and saved is the
    // failure the manual exists to prevent, so that tool never depends on another definition.
    const manual = graphOf(tools.get(SAVE)).description;
    assert.ok(manual.length > 20_000, `${label}: the saving tool documents the graph (${manual.length} characters)`);
    assert.match(manual, /start_node/);

    const pointer = graphOf(tools.get(VALIDATE));
    assert.equal(pointer.type, "object");
    assert.ok(pointer.description.length < 500, `${label}: ${pointer.description.length} characters`);
    assert.match(pointer.description, new RegExp(SAVE));
    assert.match(pointer.description, /start_node, nodes/);
    // Only the text is shared. The shape of a graph stays on both tools, so a client can still
    // check one before it makes either call.
    const { description: _manual, ...shape } = graphOf(tools.get(SAVE));
    const { description: _pointer, ...pointerShape } = pointer;
    assert.deepEqual(pointerShape, shape);
    assert.deepEqual(pointer.required, ["start_node", "nodes"]);
    // Nothing else about the validating tool changes: same arguments, same required one.
    assert.deepEqual(tools.get(VALIDATE).inputSchema.required, ["graph"]);
    assert.ok("workflow_type" in tools.get(VALIDATE).inputSchema.properties);

    // A tool that words its own `graph` argument keeps its wording.
    assert.match(graphOf(tools.get("didit_workflow_get_branch_fields")).description, /^REQUIRED\. The candidate graph/);
    const copies = [...tools.values()].filter((tool) => JSON.stringify(tool.inputSchema).includes(manual.slice(0, 200))).map((tool) => tool.name);
    assert.deepEqual(copies, [SAVE], `${label}: exactly one tool carries the manual`);
  }
});

test("a graph tool that is shown without the saving tool carries the manual itself", async () => {
  // Described on its own: a short catalog lists neither graph tool, and didit_tool_describe is
  // how a model reads one. Neither is told to read a description it was never given.
  await withClient({ hosted: true, selection: parseSelection(CORE_TOOLSET, false) }, PERSON, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes(SAVE) && !names.includes(VALIDATE));
    for (const name of [SAVE, VALIDATE]) {
      const { tools } = (await client.callTool({ name: "didit_tool_describe", arguments: { names: [name] } })).structuredContent;
      assert.ok(tools[0].inputSchema.properties.graph.description.length > 20_000, name);
    }
  });

  // Listed without it, on a read-only connection: the saving tool is gone and the validating
  // tool documents the graph itself.
  const readOnly = await listed({ hosted: true, selection: parseSelection("all", true) }, PERSON);
  assert.equal(readOnly.has(SAVE), false);
  assert.ok(graphOf(readOnly.get(VALIDATE)).description.length > 20_000);

  // Listed without it, for a role that may read workflows but not change them, once roles are enforced.
  const previous = process.env.MCP_PERMISSION_MODE;
  process.env.MCP_PERMISSION_MODE = "enforce";
  try {
    const tools = await listed({ hosted: true }, { ...PERSON, scopes: ["read:workflows"] });
    assert.equal(tools.has(SAVE), false, "the role cannot run the saving tool, so it is not listed");
    assert.ok(graphOf(tools.get(VALIDATE)).description.length > 20_000);
  } finally {
    if (previous === undefined) delete process.env.MCP_PERMISSION_MODE;
    else process.env.MCP_PERMISSION_MODE = previous;
  }
});

test("no tool of an API key connection takes organization_id or application_id", async () => {
  // Compared with a management grant: a full-access key has the Authentication setup tools too.
  const MANAGER = { ...PERSON, scopes: ["didit:management"] };
  const [forKey, forPerson] = await Promise.all([listed({ hosted: true, apiKey: true }, KEY), listed({ hosted: true }, MANAGER)]);
  const declaring = [...forKey.values()].filter((tool) => ROUTING_IDS.some((id) => id in (tool.inputSchema.properties ?? {}))).map((tool) => tool.name);
  assert.deepEqual(declaring, []);
  const requiring = [...forKey.values()].filter((tool) => ROUTING_IDS.some((id) => (tool.inputSchema.required ?? []).includes(id))).map((tool) => tool.name);
  assert.deepEqual(requiring, []);

  // Only the two ids go: every other argument, and what is required of it, is what a person gets.
  for (const [name, tool] of forKey) {
    const same = forPerson.get(name);
    const without = (keys) => (keys ?? []).filter((key) => !ROUTING_IDS.includes(key)).sort();
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), without(Object.keys(same.inputSchema.properties ?? {})), name);
    assert.deepEqual(without(tool.inputSchema.required), without(same.inputSchema.required), name);
    assert.equal(tool.description, same.description, name);
  }
  // A tool whose only required arguments were the ids has no `required` left, not an empty one.
  assert.equal("required" in forKey.get("didit_org_get_application").inputSchema, false);
  assert.deepEqual([...forPerson.get("didit_org_get_application").inputSchema.required].sort(), ["application_id", "organization_id"]);

  // A person's list still has them: several organizations and applications are theirs to choose from.
  assert.match(forPerson.get("didit_webhook_list").inputSchema.properties.application_id.description, /didit_context_get/);
});

test("the discovery tools describe a tool to an API key connection without the routing ids too", async () => {
  await withClient({ hosted: true, apiKey: true, selection: parseSelection(CORE_TOOLSET, false) }, KEY, async (client) => {
    const { tools } = (await client.callTool({ name: "didit_tool_describe", arguments: { names: ["didit_webhook_delete"] } })).structuredContent;
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties).filter((key) => ROUTING_IDS.includes(key)), []);
    assert.ok(tools[0].inputSchema.required.length > 0, "its own required argument stays");
  });
});

// A person names a session by the number the console shows. An assistant that had the number and
// no id typed a session id that did not exist (the console Copilot, 11 Nov 2026), and the hint
// that would have sent it to an exact lookup lived in that assistant's system prompt, where it
// reached conversations that were never offered this tool. The argument itself says it now. It
// costs the list nothing: the two descriptions no longer repeat the statuses their `status`
// argument already lists.
test("the session search and list tools say how to find a session by its number", async () => {
  const tools = await listed({ hosted: true }, PERSON);
  const search = tools.get("didit_session_search");
  const list = tools.get("didit_session_list");
  assert.match(search.inputSchema.properties.search.description, /S-<number> finds a user verification by number exactly/);
  assert.match(search.inputSchema.properties.search.description, /B-<number> with session_kind business/);
  assert.match(search.inputSchema.properties.search.description, /bare number is a prefix search/);
  assert.match(list.inputSchema.properties.search.description, /S-<number> finds a session by number exactly/);
  for (const tool of [search, list]) {
    // Said once, on the argument that takes it.
    assert.match(tool.inputSchema.properties.status.description, /Not Started, In Progress, In Review/, tool.name);
    assert.doesNotMatch(tool.description, /Not Started, In Progress/, tool.name);
  }
});

test("the tool list stays within its budget", async () => {
  // Bytes of name, description and input schema: what a model reads on every request. On
  // Claude the full list is about 0.4 tokens per byte.
  //
  // If this fails because a tool was added or a description grew, that may be right: look at
  // what the new text costs every connection, see whether it repeats something a model is
  // already told, and raise the number here in the same change. If nothing was added, something
  // that was sent once is being sent again.
  const budgets = [
    // Raised by 9 KB when seven tools that declared no arguments got theirs and five lists got paging,
    // by 500 bytes for the workflow setting is_session_reference_enabled (create and update), and by
    // 1.5 KB when the seven session import tools declared the organization and application they act
    // in: without them every import call a person made was refused. By 200 bytes when
    // merge_node_config said that a config map merges by entry, and by 300 when the workflow and
    // session tools said which id an integration uses (the stable workflow_id; a version uuid pins
    // one version). By 100 bytes for the OCR setting document_selfie_portrait_match_not_computed_action
    // (backend v5.1.223): it costs 52 bytes, its name once in the graph manual of the saving tool,
    // and the list stood 36 bytes under the number before it. By 900 bytes when a questionnaire
    // question could carry a stable `id` (the graph node key its answer is stored under) and the
    // two write tools began stating the shapes of the conditional fields a questionnaire keeps
    // (and refusing a malformed one instead of writing a questionnaire that silently lacked it):
    // their shared `form_elements` schema, with the list 84 bytes under the number before it and
    // 4 under this one. By 700 bytes for questionnaire_uuid on didit_workflow_get_branch_fields:
    // the backend only generates questionnaire.answers.* fields when the request names the
    // questionnaire, so without the parameter the Copilot concluded that branching on an answer
    // was impossible; field_definitions now points there for those fields. By 1 KB when the
    // questionnaire write tools accepted a `next` the order implies (so a didit_questionnaire_get
    // read can be sent back), refused a dangling `goto`/rule `field`, and said that an update must
    // send each stored question's id again: their shared form_elements schema and the update
    // description carry it, and the list stood 842 bytes over the old number. By 1.6 KB when
    // didit_questionnaire_get began returning `form_elements` and naming it as the list to send
    // back (with `sections` marked as display grouping, not the question order), the update tool
    // said to send that list back and that a reorder is reported in `warnings`, and delete said
    // what it deletes: the three descriptions carry it. The get description was then cut back to
    // four sentences and `languages` now says an update keeps the stored ones (a plain string is
    // written in all of them): the list stood 176 bytes under this number.
    // Raised by 30,268 bytes with the 21 Bank data and Bank Link tools (src/tools/bank-data.ts): the list stood at
    // 273,679 without them. What the family shares (flow, data model, sandbox, deletion) is written once, on
    // didit_bank_link_create, and the other tools keep to what they do: 21 x 360 bytes of that is the routing
    // properties every tool carries.
    ["a signed-in person on the hosted server", { hosted: true }, PERSON, 303_947],
    // A management grant also receives the six Authentication setup schemas.
    ["a hosted management grant", { hosted: true }, { ...PERSON, scopes: ["didit:management"] }, 310_491],
    // Raised by 200 bytes with them: the questionnaire shapes (980) and questionnaire_uuid (651)
    // reach an API key connection too, and together took its list to 207,087. By 1 KB with the
    // questionnaire round-trip text above: the API key list moved to 207,982. By 1 KB with the
    // questionnaire `form_elements`/delete text: the API key list moved to 209,164.
    // By 30,268 bytes with the Bank data tools: 231,880 bytes. By 5,119 bytes when a full-access key
    // (the primary secret included) got the six Authentication setup tools a management grant has
    // (service-didit-auth v3.208, a key without scopes covers every resource): 236,999 bytes.
    ["an API key connection", { hosted: true, apiKey: true }, KEY, 237_000],
    ["the short catalog", { hosted: true, selection: parseSelection(CORE_TOOLSET, false) }, PERSON, 31_500],
  ];
  for (const [label, options, authInfo, budget] of budgets) {
    const bytes = definitionBytes(await listed(options, authInfo));
    assert.ok(bytes <= budget, `${label}: ${bytes.toLocaleString("en-US")} bytes of tool definitions, the budget is ${budget.toLocaleString("en-US")}`);
  }
});
