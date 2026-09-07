import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// DID-2420: the advertised schemas must make the failing calls impossible to mis-shape.
// - didit_workflow_get_branch_fields: graph + branch_node_id required, each saying where it comes from.
// - didit_workflow_get_field_definitions / didit_compliance_check_workflow: workflow_id is an id, not a label.
// - didit_workflow_build_graph: document_rules[].country accepts the 'ALL' wildcard (DID-2419).

async function listTools() {
  const server = createServer();
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();

  return new Map(tools.map((tool) => [tool.name, tool]));
}

test("get_branch_fields requires graph and branch_node_id and says where each comes from", async () => {
  const { inputSchema } = (await listTools()).get("didit_workflow_get_branch_fields");

  assert.deepEqual(inputSchema.required, ["workflow_id", "graph", "branch_node_id"]);
  assert.equal("node_id" in inputSchema.properties, false);
  assert.match(inputSchema.properties.graph.description, /didit_workflow_get_graph \/ ui_workflow_get_graph/);
  assert.match(inputSchema.properties.branch_node_id.description, /id of a branch node in that graph/);
});

test("workflow_id on field_definitions and compliance_check is documented as an id, never a label", async () => {
  const tools = await listTools();
  for (const name of ["didit_workflow_get_field_definitions", "didit_compliance_check_workflow"]) {
    const { description } = tools.get(name).inputSchema.properties.workflow_id;
    assert.match(description, /NOT a label, slug or node id/, name);
    assert.match(description, /candidates are listed/, name);
  }
});

test("build_graph documents the document_rules country wildcard 'ALL'", async () => {
  const tool = (await listTools()).get("didit_workflow_build_graph");
  const rules = tool.inputSchema.properties.document_rules;

  assert.match(tool.description, /country wildcard 'ALL'/);
  assert.match(rules.description, /\{country:'ALL', document:'P', action:'only'\}/);
  assert.match(rules.items.properties.country.description, /'ALL' = every catalog country/);
  assert.deepEqual(rules.items.required, ["country", "document"]);
});
