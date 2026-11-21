import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { isPrivilegedToolName } from "../dist/privileged-tools.js";
import { exportToolCatalog, toolCatalogMarkdown } from "../scripts/export-tool-catalog.mjs";

// The public documentation keeps a copy of this export and checks its tool reference and its
// tool counts against it (the docs said 177 tools when the count was 185, and eight tools had no
// row). These pin what the export promises: it is exactly what the hosted server lists to a
// signed-in person, typed the way a client groups tools, and stable from one run to the next.

const claims = Buffer.from(JSON.stringify({ scope: "didit:management" })).toString("base64url");
process.env.DIDIT_ACCESS_TOKEN = `local.${claims}.fixture`;

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
  const person = { token: "person.access.token", clientId: "client", scopes: ["didit:management"], extra: {} };
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
    // One permission, or the whole set the endpoint accepts any one of (read/list on a GET).
    const permissions = Array.isArray(tool.permission) ? tool.permission : [tool.permission];
    assert.ok(tool.permission === null || permissions.length > 0, `${tool.name}: ${tool.permission}`);
    for (const permission of permissions) {
      assert.ok(permission === null || /^[a-z]+:[a-z-]+$/.test(permission), `${tool.name}: ${permission}`);
    }
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

// The profiles: what one signed-in connection lists for a selection of the catalog (toolsets.ts).
// The mirror's docs/TOOLS.md said 38 tools when the public server listed 167, because it was
// written by grepping names out of the source; it is now written from this export.

test("each profile is what a signed-in connection with that selection lists", async () => {
  const { all, core, all_read_only: readOnly } = catalog.profiles;
  assert.deepEqual(all.tools.map((tool) => tool.name), catalog.hosted.tools.map((tool) => tool.name));
  assert.equal(all.total, catalog.hosted.total);
  assert.deepEqual(all.discovery, [], "the whole catalog needs no discovery tools");

  assert.ok(core.total < all.total);
  assert.deepEqual(core.discovery, ["didit_tool_call_read", "didit_tool_call_write", "didit_tool_describe", "didit_tool_search"]);
  const everything = new Set(all.tools.map((tool) => tool.name));
  for (const tool of core.tools) assert.ok(everything.has(tool.name) || core.discovery.includes(tool.name), tool.name);

  assert.equal(readOnly.read_only, true);
  assert.equal(readOnly.total, catalog.hosted.read);
  for (const tool of readOnly.tools) assert.equal(tool.type, "read", tool.name);

  for (const profile of [all, core, readOnly]) {
    assert.equal(profile.total, profile.tools.length);
    assert.equal(typeof profile.instructions, "string");
    assert.ok(profile.instructions.length > 0);
    for (const tool of profile.tools) {
      assert.ok(Array.isArray(tool.properties), tool.name);
      for (const name of tool.required) assert.ok(tool.properties.includes(name), `${tool.name}: ${name}`);
      assert.equal(tool.confirm, tool.properties.includes("confirm"), tool.name);
    }
  }
});

test("the tool reference states the hosted total and lists every tool once, under its group", () => {
  const markdown = toolCatalogMarkdown(catalog);
  const { hosted, local_only: localOnly } = catalog;
  assert.match(markdown, new RegExp(`\\*\\*${hosted.total} tools\\*\\* to a signed-in person: ${hosted.read} read, ${hosted.write} write and ${hosted.destructive} destructive`));
  for (const tool of [...hosted.tools, ...localOnly.tools]) {
    const rows = markdown.split("\n").filter((line) => line.startsWith(`| \`${tool.name}\` | ${tool.type} |`));
    assert.equal(rows.length, 1, tool.name);
  }
  const counted = [...markdown.matchAll(/^## (.+) \((\d+)\)$/gm)].filter(([, group]) => group !== "Local server only");
  assert.equal(counted.reduce((sum, [, , n]) => sum + Number(n), 0), hosted.total);
  assert.match(markdown, new RegExp(`\\| \\\`core\\\` \\| ${catalog.profiles.core.total}, of which 4 are discovery tools \\|`));
  assert.doesNotMatch(markdown, /\u2014/, "no em dashes in published prose");
});
