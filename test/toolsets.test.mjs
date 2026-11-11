// Toolsets: a connection may load a short catalog and name the areas it wants on top.
//
// The whole catalog is more than 200 tools. Listing all of it spends tens of thousands of
// tokens on every request, and some clients cap how many tools they accept (a model does not
// pick worse from the long list: that was measured). So a connection may name what it wants: `core` is a short list,
// `all` is everything, and a connection that names nothing gets everything, as it always did.
// These tests pin the contract that makes a short catalog safe:
//
//   - toolsets are opt-in: a client that never heard of them sees no difference;
//   - a toolset decides what tools/list RETURNS, never what a caller may RUN;
//   - read-only is enforced on every call, whatever the client lists or remembers;
//   - `core` stays small (a budget, checked here), and nothing falls outside a toolset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "../dist/index.js";
import {
  ALL_TOOLSETS,
  CORE_TOOLS,
  CORE_TOOLSET,
  SELECTABLE_TOOLSET_IDS,
  TOOLSETS,
  defaultToolsets,
  parseSelection,
  selectionFromArgv,
  selectionFromRequest,
  selectionLabel,
  toolGroupOf,
  toolsetOf,
} from "../dist/toolsets.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;
delete process.env.DIDIT_TOOLSETS;
delete process.env.DIDIT_READ_ONLY;
delete process.env.MCP_PERMISSION_MODE;
delete process.env.MCP_DEFAULT_TOOLSETS;

const HOSTED_AUTH = { token: "user-token", clientId: "test-client", scopes: [], extra: {} };
const DISCOVERY = ["didit_tool_search", "didit_tool_describe", "didit_tool_call_read", "didit_tool_call_write"];

/** The selection of a request on a server whose default is the short catalog. */
const select = (toolsets, readOnly = false) => parseSelection(toolsets, readOnly, CORE_TOOLSET);

async function withClient(options, fn, authInfo) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (authInfo) {
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, sendOptions) => send(message, { ...(sendOptions ?? {}), authInfo });
  }
  const server = createServer(options);
  await server.connect(serverTransport);
  const client = new Client({ name: "toolsets-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const hosted = (selection, fn) => withClient({ hosted: true, selection }, fn, HOSTED_AUTH);
const names = async (client) => (await client.listTools()).tools.map((tool) => tool.name);
/** What a model is sent for a tool: its name, description and input schema. */
const modelFacingChars = (tools) =>
  JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))).length;

// ---------------------------------------------------------------------------
// Parsing what a connection asked for
// ---------------------------------------------------------------------------

test("toolsets are opt-in: a connection that names nothing gets everything", () => {
  for (const requested of [undefined, null, "", "   "]) {
    const selection = parseSelection(requested, false);
    assert.equal(selection.toolsets, ALL_TOOLSETS, JSON.stringify(requested));
    assert.equal(selection.readOnly, false);
    assert.deepEqual(selection.unknown, []);
  }
  assert.equal(defaultToolsets({}), "all", "a deployment that sets nothing serves everything");
  assert.equal(selectionFromRequest({}, {}, defaultToolsets({})).toolsets, ALL_TOOLSETS);
  assert.equal(selectionFromArgv([], {}).toolsets, ALL_TOOLSETS);
});

test("a deployment may make the short catalog its default", () => {
  assert.equal(defaultToolsets({ MCP_DEFAULT_TOOLSETS: " core " }), "core");
  assert.equal(defaultToolsets({ MCP_DEFAULT_TOOLSETS: "   " }), "all", "blank is unset");
  for (const requested of [undefined, null, "", "   "]) {
    const selection = select(requested);
    assert.deepEqual([...selection.toolsets], [CORE_TOOLSET], JSON.stringify(requested));
  }
});

test("toolsets are comma or space separated, case-insensitive, and accept a dash for an underscore", () => {
  assert.equal(selectionLabel(select("Core, Transactions  cases")), "core,transactions,cases");
  assert.equal(selectionLabel(select("sessions")), "sessions", "naming toolsets replaces the default");
  assert.equal(selectionLabel(select("default,webhooks")), "core,webhooks", "`default` adds to the default");
  assert.equal(select("all").toolsets, ALL_TOOLSETS);
  assert.equal(select("core,all").toolsets, ALL_TOOLSETS);
  const underscored = SELECTABLE_TOOLSET_IDS.find((id) => id.includes("_"));
  if (underscored) assert.equal(selectionLabel(select(underscored.replace(/_/g, "-"))), underscored);
});

test("an unknown toolset is reported and ignored: it never empties the catalog or refuses the connection", () => {
  const mixed = select("core,nope,transactions");
  assert.equal(selectionLabel(mixed), "core,transactions");
  assert.deepEqual(mixed.unknown, ["nope"]);

  const onlyUnknown = select("nope");
  assert.equal(selectionLabel(onlyUnknown), "core", "nothing valid falls back to the default");
  assert.deepEqual(onlyUnknown.unknown, ["nope"]);
});

test("the server default is configurable, and a broken default falls back to everything", () => {
  assert.equal(parseSelection(undefined, false, "all").toolsets, ALL_TOOLSETS);
  assert.equal(selectionLabel(parseSelection(undefined, false, "core,sessions")), "core,sessions");
  assert.equal(selectionLabel(parseSelection(undefined, false, "typo")), "all", "an operator's typo never empties the catalog");
  assert.equal(selectionLabel(parseSelection("webhooks", false, "all")), "webhooks", "an explicit request wins over the default");
  assert.equal(selectionLabel(parseSelection("default,webhooks", false, "all")), "all", "`default` is whatever the server's default is");
});

test("read-only accepts the usual truthy spellings and nothing else", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", true]) assert.equal(select(undefined, value).readOnly, true, String(value));
  for (const value of ["0", "false", "no", "", undefined, null, 1]) assert.equal(select(undefined, value).readOnly, false, String(value));
});

test("a hosted request selects with the URL query, or with headers; read-only from either source wins", () => {
  const fromQuery = selectionFromRequest({ toolsets: "core,cases", read_only: "true" }, {}, "core");
  assert.equal(selectionLabel(fromQuery), "core,cases");
  assert.equal(fromQuery.readOnly, true);

  const fromHeaders = selectionFromRequest({}, { "x-mcp-toolsets": "sessions", "x-mcp-readonly": "1" }, "core");
  assert.equal(selectionLabel(fromHeaders), "sessions");
  assert.equal(fromHeaders.readOnly, true);

  const both = selectionFromRequest({ toolsets: "cases" }, { "x-mcp-toolsets": "sessions", "x-mcp-readonly": "true" }, "core");
  assert.equal(selectionLabel(both), "cases", "the URL is the more specific place: it wins for toolsets");
  assert.equal(both.readOnly, true, "a safety switch set in either place stays on");

  assert.equal(selectionFromRequest({ readonly: "true" }, {}, "core").readOnly, true, "`readonly` is accepted too");
  // A repeated query parameter arrives as an array: the first value is used, never a crash.
  assert.equal(selectionLabel(selectionFromRequest({ toolsets: ["cases", "sessions"] }, {}, "core")), "cases");
  assert.equal(selectionFromRequest({}, {}, "all").toolsets, ALL_TOOLSETS, "no request: the server default");
});

test("a local server selects with flags, or with the environment", () => {
  assert.equal(selectionLabel(selectionFromArgv([], {})), "all");
  assert.equal(selectionLabel(selectionFromArgv(["--toolsets=core,cases"], {})), "core,cases");
  assert.equal(selectionLabel(selectionFromArgv(["--toolsets", "sessions"], {})), "sessions");
  assert.equal(selectionFromArgv(["--read-only"], {}).readOnly, true);
  assert.equal(selectionLabel(selectionFromArgv([], { DIDIT_TOOLSETS: "core" })), "core");
  assert.equal(selectionFromArgv([], { DIDIT_READ_ONLY: "true" }).readOnly, true);
  assert.equal(selectionLabel(selectionFromArgv(["--toolsets=cases"], { DIDIT_TOOLSETS: "core" })), "cases", "a flag wins over the environment");
});

// ---------------------------------------------------------------------------
// The catalog and its toolsets
// ---------------------------------------------------------------------------

test("every tool belongs to a toolset, so no tool can be missing from every selection", async () => {
  await withClient({}, async (client) => {
    const orphans = (await names(client)).filter((name) => !toolsetOf(name));
    assert.deepEqual(orphans, [], "give the tool a `didit_<domain>_` name whose prefix a toolset in toolsets.ts claims");
  });
});

test("toolset ids are unique, lowercase and described; every toolset holds at least one tool", async () => {
  const ids = TOOLSETS.map((toolset) => toolset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const toolset of TOOLSETS) {
    assert.match(toolset.id, /^[a-z][a-z_]*$/, toolset.id);
    assert.ok(toolset.description.length > 20 && toolset.description.endsWith("."), `${toolset.id} description`);
    assert.notEqual(toolset.id, CORE_TOOLSET);
    assert.notEqual(toolset.id, ALL_TOOLSETS);
  }
  await withClient({}, async (client) => {
    const present = new Set((await names(client)).map(toolsetOf));
    for (const id of SELECTABLE_TOOLSET_IDS) assert.ok(present.has(id), `toolset '${id}' holds no tool`);
  });
});

test("the README documents every toolset a person can select, with its description", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  for (const toolset of TOOLSETS.filter((candidate) => SELECTABLE_TOOLSET_IDS.includes(candidate.id))) {
    assert.ok(readme.includes(`| \`${toolset.id}\` | ${toolset.description} |`), `README.md has no row for the '${toolset.id}' toolset`);
  }
});

test("every core tool exists, and the group label of a tool is its toolset's", async () => {
  await withClient({}, async (client) => {
    const catalog = new Set(await names(client));
    assert.deepEqual([...CORE_TOOLS].filter((name) => !catalog.has(name)), [], "core names a tool that does not exist");
  });
  assert.equal(toolGroupOf("didit_session_create"), "Sessions");
  assert.equal(toolGroupOf("didit_blocklist_add"), "Lists & Blocklist");
  assert.equal(toolGroupOf("didit_tool_search"), "Tool Discovery");
  assert.equal(toolsetOf("didit_tool_search"), undefined, "the discovery tools stand in for the rest: they are in no toolset");
});

test("createServer() without a selection narrows nothing: the whole catalog, no discovery tools", async () => {
  await withClient({}, async (client) => {
    const listed = await names(client);
    assert.ok(listed.length > 100, `only ${listed.length} tools`);
    for (const name of DISCOVERY) assert.ok(!listed.includes(name), `${name} has nothing to discover here`);
  });
});

// ---------------------------------------------------------------------------
// What a connection lists
// ---------------------------------------------------------------------------

test("the core catalog is the core tools plus the discovery tools, and it stays within its budget", async () => {
  await hosted(select("core"), async (client) => {
    const { tools } = await client.listTools();
    const listed = tools.map((tool) => tool.name);
    for (const name of DISCOVERY) assert.ok(listed.includes(name), `${name} missing`);
    const rest = listed.filter((name) => !DISCOVERY.includes(name));
    assert.deepEqual(rest.filter((name) => !CORE_TOOLS.has(name)), [], "only core tools are listed");
    assert.ok(rest.includes("didit_context_get") && rest.includes("didit_session_create"));
    // A hosted server authenticates with OAuth: the sign-in tools are never offered there.
    assert.deepEqual(rest.filter((name) => name.startsWith("didit_account_")), []);

    // THE BUDGET. A conversation that chose the short catalog pays for this list before anything
    // is asked. Raising these numbers is a decision, not a fix: move the tool to a toolset
    // instead, where it costs only the conversations that asked for it.
    assert.ok(listed.length <= 30, `${listed.length} tools in the core catalog (budget: 30)`);
    const chars = modelFacingChars(tools);
    assert.ok(chars <= 40_000, `${chars} characters of tool definitions in the core catalog (budget: 40,000, about 10k tokens)`);
  });
});

test("naming a toolset loads all of it; `all` loads everything and drops the discovery tools", async () => {
  await hosted(select("core,cases"), async (client) => {
    const listed = await names(client);
    for (const name of ["didit_case_create", "didit_case_manage", "didit_case_statistics", "didit_session_create"]) {
      assert.ok(listed.includes(name), `${name} missing`);
    }
    assert.ok(!listed.includes("didit_blocklist_add"), "a toolset that was not named is not listed");
    assert.ok(listed.includes("didit_tool_search"), "something is still unloaded, so discovery is offered");
  });
  await hosted(select("cases"), async (client) => {
    const listed = await names(client);
    assert.ok(listed.includes("didit_case_create"));
    assert.ok(!listed.includes("didit_session_create"), "naming toolsets replaces the default: core is not implied");
    assert.ok(listed.includes("didit_context_get"), "the tool that returns the ids everything needs is always listed");
  });
  await hosted(select("all"), async (client) => {
    const listed = await names(client);
    const everything = await withClient({ hosted: true }, names, HOSTED_AUTH);
    assert.deepEqual(listed, everything, "`all` is exactly the unnarrowed catalog");
    for (const name of DISCOVERY) assert.ok(!listed.includes(name));
  });
});

test("the list order is stable across requests", async () => {
  const first = await hosted(select("core,cases"), names);
  const second = await hosted(select("core,cases"), names);
  assert.deepEqual(first, second);
});

test("a listed tool carries the routing ids in one line each, and a tool that words its own keeps it", async () => {
  await hosted(select("all"), async (client) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const routing = byName.get("didit_webhook_list").inputSchema.properties;
    assert.equal(routing.organization_id.type, "string");
    assert.ok(routing.organization_id.description.length < 80, routing.organization_id.description);
    assert.match(routing.application_id.description, /didit_context_get/);
    assert.match(routing.application_id.description, /Optional/);
    // A tool that REQUIRES the id never calls it optional.
    const listKeys = byName.get("didit_org_list_api_keys").inputSchema;
    assert.ok(listKeys.required.includes("application_id"));
    assert.doesNotMatch(listKeys.properties.application_id.description, /Optional/);
    // A tool that words the id itself keeps its wording.
    const own = byName.get("didit_org_create_api_key").inputSchema.properties.organization_id.description;
    assert.match(own, /^REQUIRED/);
  });
});

// ---------------------------------------------------------------------------
// A toolset is a context budget, not access control
// ---------------------------------------------------------------------------

test("a tool outside the selection still runs when called by name", async () => {
  await hosted(select("core"), async (client) => {
    assert.ok(!(await names(client)).includes("didit_workflow_get_feature_config_schema"));
    const result = await client.callTool({ name: "didit_workflow_get_feature_config_schema", arguments: {} });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  });
});

test("an unknown tool name points at the search tool", async () => {
  await hosted(select("core"), async (client) => {
    const result = await client.callTool({ name: "didit_does_not_exist", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool: didit_does_not_exist/);
    assert.match(result.content[0].text, /didit_tool_search/);
  });
});

// ---------------------------------------------------------------------------
// Read-only is a safety boundary
// ---------------------------------------------------------------------------

test("a read-only connection lists only tools that read", async () => {
  await hosted(select("all", true), async (client) => {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 50);
    const writers = tools.filter((tool) => tool.annotations.readOnlyHint !== true).map((tool) => tool.name);
    assert.deepEqual(writers, []);
  });
  await hosted(select("core", true), async (client) => {
    const listed = await names(client);
    assert.ok(listed.includes("didit_tool_call_read"));
    assert.ok(!listed.includes("didit_tool_call_write"), "there is nothing a read-only connection may write");
    assert.ok(!listed.includes("didit_session_create"));
    assert.ok(listed.includes("didit_session_search"));
  });
});

test("a read-only connection refuses every call that changes data: listed or not, direct or through a discovery tool", async () => {
  await hosted(select("all", true), async (client) => {
    const attempts = [
      { name: "didit_session_create", arguments: { workflow_id: "wf" } },
      { name: "didit_session_delete", arguments: { session_id: "s" } },
      { name: "didit_tool_call_write", arguments: { name: "didit_session_delete", arguments: { session_id: "s" } } },
      { name: "didit_tool_call_read", arguments: { name: "didit_session_delete", arguments: { session_id: "s" } } },
    ];
    for (const attempt of attempts) {
      const result = await client.callTool(attempt);
      assert.equal(result.isError, true, JSON.stringify(attempt));
      assert.match(result.content[0].text, /read-only/, JSON.stringify(attempt));
      assert.match(result.content[0].text, /read_only=true|X-MCP-Readonly/, "the refusal says how to allow changes");
    }
    // A read still runs.
    const read = await client.callTool({ name: "didit_workflow_get_feature_config_schema", arguments: {} });
    assert.notEqual(read.isError, true);
  });
});

test("a local read-only server names its own switch in the refusal", async () => {
  await withClient({ selection: select("core", true) }, async (client) => {
    const result = await client.callTool({ name: "didit_session_delete", arguments: { session_id: "s" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /--read-only|DIDIT_READ_ONLY/);
  });
});
