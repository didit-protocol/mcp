import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * didit_workflow_build_graph: the deterministic spec->graph door for free-form
 * copilot builds (staging 2026-09-02: one request burned 151 editor calls).
 * Pins the gate-then-commit contract surface and the validate tool's now
 * optional workflow_id (an unsaved canvas has no version uuid to pass).
 */

async function listTools() {
  const server = createServer();
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();

  return new Map(tools.map((tool) => [tool.name, tool]));
}

test("build_graph is a read-only workflow tool with the spec surface", async () => {
  const byName = await listTools();
  const build = byName.get("didit_workflow_build_graph");

  assert.ok(build, "didit_workflow_build_graph missing from tools/list");
  assert.equal(build.annotations.readOnlyHint, true);
  for (const key of ["subject", "features", "countries", "document_rules", "per_feature_config", "branches"]) {
    assert.ok(build.inputSchema.properties[key], `missing property ${key}`);
  }
  assert.match(build.description, /unsupported.*questions|questions.*unsupported/s);
  assert.match(build.description, /ui_workflow_apply_graph \{spec\}/);
  assert.ok(build.inputSchema.properties.include_graph, "include_graph escape hatch missing");
  assert.match(build.description, /regulations are never consulted/i);
});

test("validate_graph no longer demands a workflow id for an unsaved canvas", async () => {
  const byName = await listTools();
  const validate = byName.get("didit_workflow_validate_graph");

  assert.deepEqual(validate.inputSchema.required, ["graph"]);
  assert.ok(validate.inputSchema.properties.workflow_type, "workflow_type escape hatch missing");
});

test("validate_graph summarizes big configs on the unsaved-canvas path too", async () => {
  const { validateWorkflowGraph } = await import("../dist/tools/workflow-graph.js");
  const { requestContext } = await import("../dist/config.js");
  const documentsAllowed = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`C${index}`, { P: { subtypes: ["A", "B", "C"] } }]),
  );
  const graph = {
    start_node: "a",
    nodes: { a: { node_type: "feature", feature: "OCR", config: { documents_allowed: documentsAllowed } } },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ valid: true, errors: [], graph }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const result = await requestContext.run(
    { accessToken: "tok-validate-unsaved", organizationId: "org-1", applicationId: "app-1" },
    () => validateWorkflowGraph(undefined, graph),
  );

  assert.equal(result.config_summarized, true);
  assert.ok(JSON.stringify(result.graph).length < JSON.stringify(graph).length / 4, "config not summarized");
});
