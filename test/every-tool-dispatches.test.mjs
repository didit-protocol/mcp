import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// A tool is defined in one place (the tool list) and run in another (the dispatcher). A tool
// that is listed with no branch in the dispatcher looks fine to every other test and to
// tools/list, and answers "Unknown tool" only when someone calls it. Every name-keyed table has
// its own guard (permissions, toolsets, the person-only list); this is the one for the dispatcher.

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;
// The account tools keep a sign-in on success; nothing here succeeds, but never touch the real file.
process.env.DIDIT_MCP_CREDENTIALS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "didit-dispatch-")), "mcp-credentials.json");

const { createServer } = await import("../dist/index.js");

// Nothing leaves the process: every request a handler makes is answered here with an empty object.
globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

async function withClient(options, authInfo, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  }
  const client = new Client({ name: "dispatch-guard", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (result) => (result.content ?? []).map((block) => block.text ?? "").join("\n");

/** Call every listed tool with no arguments; return the names the dispatcher does not know. */
async function unknownTools(options, authInfo) {
  return withClient(options, authInfo, async (client) => {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 100, `only ${tools.length} tools were listed`);
    const unknown = [];
    for (const tool of tools) {
      // Whatever a handler makes of empty arguments (most refuse them), it must be the tool's own answer.
      const result = await client.callTool({ name: tool.name, arguments: {} }).catch((error) => ({ content: [{ text: String(error) }] }));
      if (/^Unknown tool\b/.test(textOf(result))) unknown.push(tool.name);
    }
    return { unknown, count: tools.length };
  });
}

test("every tool the local server lists has a handler", async () => {
  const { unknown, count } = await unknownTools({});
  assert.deepEqual(unknown, [], `listed but not dispatched (${unknown.length} of ${count})`);
});

test("every tool the hosted server lists to a signed-in person has a handler", async () => {
  const person = { token: "person.access.token", clientId: "client", scopes: [], extra: { organization_id: "69f2b990-24e3-4892-bbe7-1a6a628943b3" } };
  const { unknown, count } = await unknownTools({ hosted: true }, person);
  assert.deepEqual(unknown, [], `listed but not dispatched (${unknown.length} of ${count})`);
});

test("a name the server does not have is the one thing that answers Unknown tool", async () => {
  await withClient({}, undefined, async (client) => {
    const result = await client.callTool({ name: "didit_this_tool_does_not_exist", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Unknown tool: didit_this_tool_does_not_exist/);
  });
});
