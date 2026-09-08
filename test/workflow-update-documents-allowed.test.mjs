import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Prod 7-8 Sep 2026 (copilot threads 66c05f03 / 5ee82c9b): "only Mexico" on a
// SIMPLE workflow was unreachable — the handler already forwarded
// `documents_allowed` to the settings PATCH, but the schema never said so, and
// the graph tools (which do declare it) convert the workflow into a graph one.

async function listTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "documents-allowed-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test("didit_workflow_update declares documents_allowed, its shape, the replace semantics and the no-conversion guarantee", async () => {
  const tool = (await listTools()).find((t) => t.name === "didit_workflow_update");
  assert.ok(tool, "didit_workflow_update missing from the catalog");
  const prop = tool.inputSchema.properties?.documents_allowed;
  assert.ok(prop, "documents_allowed is not declared");
  assert.equal(prop.type, "object");
  assert.match(prop.description, /"<ISO3>"/);
  assert.match(prop.description, /REPLACES the whole map/);
  assert.match(prop.description, /"MEX"/);
  assert.match(prop.description, /Does NOT convert a simple workflow/);
  assert.match(tool.description, /documents_allowed/);
});
