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
  const [forKey, forPerson] = await Promise.all([listed({ hosted: true, apiKey: true }, KEY), listed({ hosted: true }, PERSON)]);
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

test("the tool list stays within its budget", async () => {
  // Bytes of name, description and input schema: what a model reads on every request. On
  // Claude the full list is about 0.4 tokens per byte.
  //
  // If this fails because a tool was added or a description grew, that may be right: look at
  // what the new text costs every connection, see whether it repeats something a model is
  // already told, and raise the number here in the same change. If nothing was added, something
  // that was sent once is being sent again.
  const budgets = [
    // Raised by 9 KB when seven tools that declared no arguments got theirs and five lists got paging.
    ["a signed-in person on the hosted server", { hosted: true }, PERSON, 270_000],
    ["an API key connection", { hosted: true, apiKey: true }, KEY, 207_000],
    ["the short catalog", { hosted: true, selection: parseSelection(CORE_TOOLSET, false) }, PERSON, 31_500],
  ];
  for (const [label, options, authInfo, budget] of budgets) {
    const bytes = definitionBytes(await listed(options, authInfo));
    assert.ok(bytes <= budget, `${label}: ${bytes.toLocaleString("en-US")} bytes of tool definitions, the budget is ${budget.toLocaleString("en-US")}`);
  }
});
