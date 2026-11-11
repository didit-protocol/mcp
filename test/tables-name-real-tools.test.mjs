import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// A tool is defined in one place and classified in several tables keyed by its name: which
// tools are destructive, which reach outside the workspace, which are kept off the hosted
// server, which need no organization. Rename a tool in its definition and not in a table, and
// nothing fails: the entry stops matching. A destructive tool then reads as an ordinary write
// and a client no longer asks before running it.
//
// The permission table, the toolsets, the person-only list and the dispatcher each have their
// own test. This one holds the remaining tables of the server (NAME_KEYED_TABLES in index.ts):
// every name in them is a tool some connection can be given, and what the table says about the
// tool is what a client reads in its annotations.

// What a server lists depends on its environment: none of it may come from the shell that runs
// the tests. DIDIT_DOCS_MCP_URL set to nothing, for one, turns the documentation tool off, and a
// table entry for it would then look like a stray.
for (const name of ["DIDIT_ACCESS_TOKEN", "DIDIT_IS_STAFF", "MCP_DEFAULT_TOOLSETS", "MCP_PERMISSION_MODE", "DIDIT_DOCS_MCP_URL", "DIDIT_TOOLSETS", "DIDIT_READ_ONLY"]) {
  delete process.env[name];
}

const { createServer, NAME_KEYED_TABLES } = await import("../dist/index.js");
const { parseSelection } = await import("../dist/toolsets.js");

const PERSON = { token: "person.access.token", clientId: "tables-test", scopes: [], extra: { organization_id: "org-1" } };
const PRIVILEGED = { ...PERSON, extra: { ...PERSON.extra, is_privileged: true } };

async function list(options, authInfo) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  }
  const client = new Client({ name: "tables-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

const hosted = () => list({ hosted: true, moneyTools: true }, PRIVILEGED);

/**
 * Every tool any connection is given, with its annotations. No single list has them all: the
 * local server has the account tools and the key reveal that a hosted one never lists, a
 * privileged caller has tools nobody else does, a narrowed list has the discovery tools, the
 * ChatGPT catalog its console tool.
 */
async function everyTool() {
  const lists = await Promise.all([
    list({}),
    list({ hosted: true }, PERSON),
    list({ hosted: true }, PRIVILEGED),
    hosted(),
    list({ hosted: true, selection: parseSelection("core", false) }, PERSON),
    list({ hosted: true, profile: "chatgpt" }, PERSON),
  ]);
  const tools = new Map();
  for (const tool of lists.flat()) {
    // A tool is annotated the same way wherever it is listed: that is what makes one entry enough.
    if (tools.has(tool.name)) assert.deepEqual(tool.annotations, tools.get(tool.name), `${tool.name} is annotated differently on two lists`);
    else tools.set(tool.name, tool.annotations);
  }

  return tools;
}

test("every name in a name-keyed table of the server is a tool", async () => {
  const tools = await everyTool();
  assert.ok(tools.size > 100);
  assert.ok(Object.keys(NAME_KEYED_TABLES).length >= 8, "the tables are exported for this test");
  const strays = Object.entries(NAME_KEYED_TABLES).flatMap(([table, entries]) =>
    entries.filter((name) => !tools.has(name)).map((name) => `${table}: ${name}`),
  );
  assert.deepEqual(
    strays,
    [],
    "these table entries name no tool. If the tool was renamed, rename it here too: until then it has lost what the table said about it. If it was removed, remove the entry.",
  );
  for (const [table, entries] of Object.entries(NAME_KEYED_TABLES)) {
    assert.equal(new Set(entries).size, entries.length, `${table} lists a tool twice`);
  }
});

test("what the tables say reaches the list: every tool named destructive, write, read or open-world is annotated so", async () => {
  // The other half: an entry that matches must have its effect, for EVERY entry, whichever list
  // the tool is on. The tables are read in the order the server reads them: destructive wins
  // over write, write over read.
  const tools = await everyTool();
  const destructive = new Set(NAME_KEYED_TABLES.EXPLICIT_DESTRUCTIVE_TOOLS);
  const write = new Set(NAME_KEYED_TABLES.EXPLICIT_WRITE_TOOLS);
  const hints = (name) => {
    const annotations = tools.get(name);
    assert.ok(annotations, `${name} is on no list`);

    return annotations;
  };
  for (const name of destructive) assert.deepEqual([hints(name).destructiveHint, hints(name).readOnlyHint], [true, false], name);
  for (const name of NAME_KEYED_TABLES.EXPLICIT_OPEN_WORLD_TOOLS) assert.equal(hints(name).openWorldHint, true, name);
  for (const name of write) {
    if (!destructive.has(name)) assert.deepEqual([hints(name).readOnlyHint, hints(name).destructiveHint], [false, false], name);
  }
  for (const name of NAME_KEYED_TABLES.EXPLICIT_READ_TOOLS) {
    if (!destructive.has(name) && !write.has(name)) assert.equal(hints(name).readOnlyHint, true, name);
  }
});

test("a hosted server lists none of the tools it keeps for a local one, whoever asks", async () => {
  const names = new Set((await hosted()).map((tool) => tool.name));
  assert.ok(NAME_KEYED_TABLES.ACCOUNT_BOOTSTRAP_TOOLS.length > 0);
  for (const name of NAME_KEYED_TABLES.ACCOUNT_BOOTSTRAP_TOOLS) assert.equal(names.has(name), false, name);
  // The same tools exist where a person runs the server themselves.
  const local = new Set((await list({})).map((tool) => tool.name));
  for (const name of NAME_KEYED_TABLES.ACCOUNT_BOOTSTRAP_TOOLS) assert.equal(local.has(name), true, name);
});
