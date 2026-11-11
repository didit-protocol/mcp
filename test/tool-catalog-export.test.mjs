import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { isPrivilegedToolName } from "../dist/privileged-tools.js";
import { exportToolCatalog } from "../scripts/export-tool-catalog.mjs";

// The public documentation keeps a copy of this export and checks its tool reference and its
// tool counts against it (the docs said 177 tools when the count was 185, and eight tools had no
// row). These pin what the export promises: it is exactly what the hosted server lists to a
// signed-in person, typed the way a client groups tools, and stable from one run to the next.

delete process.env.DIDIT_ACCESS_TOKEN;

async function listed(options, authInfo) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  }
  const client = new Client({ name: "catalog-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

const catalog = await exportToolCatalog();
const TYPES = new Set(["read", "write", "destructive"]);

test("the hosted part is exactly what the hosted server lists to a signed-in person", async () => {
  const person = { token: "person.access.token", clientId: "client", scopes: [], extra: {} };
  const tools = await listed({ hosted: true }, person);
  assert.deepEqual(
    catalog.hosted.tools.map((tool) => tool.name),
    tools.map((tool) => tool.name).sort(),
  );
  assert.equal(catalog.hosted.total, tools.length);
});

test("every tool has a type from its annotations, and the counts add up", () => {
  for (const tool of [...catalog.hosted.tools, ...catalog.local_only.tools]) {
    assert.ok(TYPES.has(tool.type), `${tool.name}: ${tool.type}`);
    assert.equal(typeof tool.group, "string", tool.name);
    assert.ok(tool.permission === null || /^[a-z]+:[a-z-]+$/.test(tool.permission), `${tool.name}: ${tool.permission}`);
    assert.ok(Array.isArray(tool.required), tool.name);
  }
  const { read, write, destructive, total, tools } = catalog.hosted;
  assert.equal(read + write + destructive, total);
  assert.equal(read, tools.filter((tool) => tool.type === "read").length);
  assert.equal(destructive, tools.filter((tool) => tool.type === "destructive").length);
});

test("a read tool is one the client may run without asking, a destructive one asks", async () => {
  const tools = await listed({});
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const tool of [...catalog.hosted.tools, ...catalog.local_only.tools]) {
    const annotations = byName.get(tool.name).annotations;
    assert.equal(tool.type === "read", annotations.readOnlyHint === true, tool.name);
    if (tool.type === "destructive") assert.equal(annotations.destructiveHint, true, tool.name);
  }
});

test("the local-only part is what a local server lists on top, and nothing appears twice", async () => {
  const hosted = new Set(catalog.hosted.tools.map((tool) => tool.name));
  const local = catalog.local_only.tools.map((tool) => tool.name);
  assert.equal(catalog.local_only.total, local.length);
  for (const name of local) assert.ok(!hosted.has(name), `${name} is in both parts`);
  // Signing in with a password or a code, the raw key and the money tool never go to a remote connector.
  for (const name of ["didit_account_login", "didit_account_register", "didit_org_reveal_application_api_key", "didit_org_top_up"]) {
    assert.ok(local.includes(name), `${name} is missing from the local-only part`);
  }
  const everything = (await listed({})).map((tool) => tool.name).sort();
  assert.deepEqual([...hosted, ...local].sort(), everything);
});

test("staff tools are never exported, whatever the environment says", async () => {
  process.env.DIDIT_IS_STAFF = "true";
  try {
    const asStaffMachine = await exportToolCatalog();
    assert.deepEqual(asStaffMachine, catalog);
    assert.equal(process.env.DIDIT_IS_STAFF, "true", "the export must leave the environment as it found it");
  } finally {
    delete process.env.DIDIT_IS_STAFF;
  }
  for (const tool of [...catalog.hosted.tools, ...catalog.local_only.tools]) {
    assert.ok(!isPrivilegedToolName(tool.name), tool.name);
  }
});

test("the export is sorted and identical from one run to the next", async () => {
  const names = catalog.hosted.tools.map((tool) => tool.name);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(await exportToolCatalog(), catalog);
  assert.equal(typeof catalog.server_version, "string");
});
