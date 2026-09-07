import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Every tool whose handler refuses to run without `confirm: true` must SAY so in its
// schema. Four of them enforced it only at runtime, so a client could not discover the
// gate until the call failed with `unsafe_operation` — and the description is the only
// place the model is told that the flag stands for a human's explicit confirmation.

const CONFIRM_GATED_TOOLS = [
  "didit_org_reveal_application_api_key",
  "didit_session_delete",
  "didit_session_batch_delete",
  "didit_vendor_user_delete",
  "didit_vendor_business_delete",
  "didit_org_top_up",
  "didit_case_manage",
];

async function listTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "confirm-schema-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test("every runtime confirm gate is declared in the tool schema, worded as a human confirmation", async () => {
  const tools = await listTools();
  for (const name of CONFIRM_GATED_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} missing from the catalog`);
    const confirm = tool.inputSchema.properties?.confirm;
    assert.ok(confirm, `${name} does not declare confirm`);
    assert.equal(confirm.type, "boolean", `${name}.confirm must be a boolean`);
    assert.match(confirm.description, /explicit user confirmation of this exact action/, `${name}.confirm description`);
    assert.equal(tool.annotations?.destructiveHint, true, `${name} must be annotated destructive`);
  }
});
