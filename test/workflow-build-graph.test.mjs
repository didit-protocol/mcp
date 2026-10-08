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

test("the spec root is CLOSED — the level that let `branch_rules` through", async () => {
  // every nested object of this schema was already closed; the root
  // was not, so a model could add a key nobody had declared and the backend's
  // 400 was the first thing that noticed.
  const byName = await listTools();
  const build = byName.get("didit_workflow_build_graph");

  assert.equal(build.inputSchema.additionalProperties, false);
});

test("build_graph refuses an invented spec key before any request, naming the real one", async () => {
  // The console copilot sent `branch_rules` for `branches` and three users of
  // one paying organization lost their workflow to the round trip. The schema
  // tells the model; this is what enforces it.
  const { buildWorkflow } = await import("../dist/tools/compliance.js");
  const { requestContext } = await import("../dist/config.js");
  let requested = 0;
  globalThis.fetch = async () => {
    requested += 1;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await assert.rejects(
    requestContext.run({ accessToken: "tok-build", organizationId: "org-1", applicationId: "app-1" }, () =>
      buildWorkflow({ features: ["OCR"], branch_rules: [{ countries: ["MEX"], features: ["AML"] }] }),
    ),
    (error) => {
      assert.match(error.message, /Unknown spec key\(s\) branch_rules \(the key is "branches"\)/);
      assert.equal(error.shape.field, "branch_rules");
      assert.deepEqual(error.shape.allowed, [
        "branches",
        "countries",
        "document_rules",
        "features",
        "per_feature_config",
        "subject",
      ]);
      return true;
    },
  );
  assert.equal(requested, 0, "the invalid spec reached the API");
});

test("build_graph still passes the whole accepted vocabulary, routing args stripped", async () => {
  // The guard is a closed set, so it is also what would silently break the
  // builder's contract if it fell behind it. include_graph and the org/app
  // routing args are not spec keys and must survive.
  const { buildWorkflow } = await import("../dist/tools/compliance.js");
  const { requestContext } = await import("../dist/config.js");
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ graph: null, questions: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await requestContext.run({ accessToken: "tok-build-ok", organizationId: "org-1", applicationId: "app-1" }, () =>
    buildWorkflow({
      organization_id: "org-1",
      application_id: "app-1",
      include_graph: true,
      subject: "kyc",
      features: ["OCR"],
      countries: { mode: "only", list: ["MEX"] },
      document_rules: [{ country: "USA", document: "DL", state: "NV" }],
      per_feature_config: { OCR: { id_document_quality_threshold: 50 } },
      branches: [{ countries: ["MEX"], features: ["AML"] }],
    }),
  );

  assert.deepEqual(Object.keys(body).sort(), [
    "branches",
    "countries",
    "document_rules",
    "features",
    "per_feature_config",
    "subject",
  ]);
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
