// The ID Verification methods catalog tool.
//
// The OCR node's `methods` key is validated by the backend against a capability
// catalog: a lookup or wallet that is not `available` for the country is rejected
// on save. An agent can only get that right if the catalog is one tool call away
// and the `methods` key is advertised from the contract. Both are pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FEATURE_CONFIG_SCHEMA, configKeys } from "../dist/feature-config-schema.js";

async function listAdvertisedTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "catalog-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return tools;
}

test("the catalog tool is advertised as a read tool scoped by workflow_id", async () => {
  const tools = await listAdvertisedTools();
  const tool = tools.find((t) => t.name === "didit_workflow_get_id_verification_methods_catalog");
  assert.ok(tool, "didit_workflow_get_id_verification_methods_catalog must be advertised");
  assert.deepEqual(tool.inputSchema.required, ["workflow_id"]);
  assert.ok(tool.inputSchema.properties.country, "country narrows the catalog to one ISO3");
  for (const word of ["coming_soon", "accept-list", "placeholder", "methods"]) {
    assert.ok(tool.description.includes(word), `description must explain "${word}"`);
  }
});

test("the OCR `methods` key comes from the contract, with its shape and example", () => {
  assert.ok(configKeys("OCR").includes("methods"), "`methods` must be in the OCR contract");
  const field = FEATURE_CONFIG_SCHEMA.features.OCR.fields.methods;
  assert.equal(field.type, "json");
  assert.match(field.shape, /fallback_to_document/);
  assert.match(field.description, /id-verification-methods-catalog/);
  assert.ok(JSON.stringify(field.example).includes("mitid"));
});
