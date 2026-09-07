import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkflowScope } from "../dist/tools/search.js";
import { getWorkflowFieldDefinitions, getWorkflowBranchFields } from "../dist/tools/workflow-graph.js";
import { checkWorkflow } from "../dist/tools/compliance.js";
import { requestContext } from "../dist/config.js";

// DID-2420 (prod Braintrust 1-4 Sep): the model passed a label/slug ("adaptive-age-estimation")
// or a node id ("feature_ocr") as `workflow_id` to didit_workflow_get_field_definitions (30 calls)
// and didit_compliance_check_workflow (6 calls) and got "Workflow … was not found in any of your
// applications". A non-uuid id now resolves by EXACT label/slug; anything ambiguous lists the
// candidates instead of guessing. didit_workflow_get_branch_fields (19 calls) failed with
// "Both 'graph' and 'branch_node_id' are required" because the MCP posted `node_id`.

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";
const MISSING_UUID = "46868985-8bfb-41a6-ad79-23f5f6757abe";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Route fetches by exact URL path (query stripped); records every call; unrouted paths 404. */
const stubFetch = (routes) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[path];

    if (!handler) return json({ detail: "Not found." }, 404);

    return typeof handler === "function" ? handler() : json(handler);
  };
  return calls;
};

// Distinct token per test — getOrgAppMap caches the org/app map per access token.
const inContext = (token, fn) => requestContext.run({ accessToken: token }, fn);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const ROUTES = {
  [`${AUTH}/organizations/me/`]: [{ uuid: "org-1", name: "Org One" }],
  [`${AUTH}/organizations/me/org-1/applications/`]: [
    { uuid: "app-1", name: "App One" },
    { uuid: "app-2", name: "App Two" },
  ],
  [`${API}/organization/org-1/application/app-1/verification-settings/`]: {
    results: [
      { uuid: "v-1", workflow_id: "stable-1", workflow_label: "Adaptive Age Estimation" },
      { uuid: "v-2", workflow_id: "stable-2", workflow_label: "KYC Basic" },
    ],
  },
  [`${API}/organization/org-1/application/app-2/verification-settings/`]: {
    results: [{ uuid: "v-3", workflow_id: "stable-3", workflow_label: "KYC Basic" }],
  },
  [`${API}/organization/org-1/application/app-1/workflow-graph/field-definitions/`]: { fields_by_feature: {} },
  [`${API}/organization/org-1/application/app-1/compliance/workflow-check/`]: { obligations: [] },
};

test("label resolution: a slug that matches exactly one label resolves to that workflow", async () => {
  stubFetch(ROUTES);
  const scope = await inContext("lbl-1", () => resolveWorkflowScope("adaptive-age-estimation"));

  assert.equal(scope.organizationId, "org-1");
  assert.equal(scope.applicationId, "app-1");
  assert.equal(scope.workflow.uuid, "v-1");
  assert.equal(scope.resolved_from, "adaptive-age-estimation");
});

test("label resolution: an exact label (any case) resolves inside the given org/app scope", async () => {
  stubFetch(ROUTES);
  const scope = await inContext("lbl-2", () => resolveWorkflowScope("kyc basic", "org-1", "app-2"));

  assert.equal(scope.applicationId, "app-2");
  assert.equal(scope.workflow.uuid, "v-3");
});

test("label resolution: several matches list every candidate (label → id) and never guess", async () => {
  stubFetch(ROUTES);
  const err = await threw(() => inContext("lbl-3", () => resolveWorkflowScope("KYC Basic")));

  assert.equal(err?.name, "DiditError");
  assert.equal(err.shape.code, "bad_request");
  assert.equal(err.shape.field, "workflow_id");
  assert.match(err.message, /Several workflows are labelled "KYC Basic"/);
  assert.match(err.shape.hint, /"KYC Basic" → stable-2/);
  assert.match(err.shape.hint, /"KYC Basic" → stable-3/);
  assert.doesNotMatch(err.shape.hint, /stable-1/);
});

test("label resolution: a node id matches nothing → bad_request listing the workflows in scope", async () => {
  stubFetch(ROUTES);
  const err = await threw(() => inContext("lbl-4", () => resolveWorkflowScope("feature_ocr", "org-1", "app-1")));

  assert.equal(err?.shape?.code, "bad_request");
  assert.match(err.message, /No workflow is labelled "feature_ocr"/);
  assert.match(err.message, /not a label or a node id/);
  assert.match(err.shape.hint, /"Adaptive Age Estimation" → stable-1; "KYC Basic" → stable-2/);
});

test("label resolution: the candidate list is capped at 10", async () => {
  const results = Array.from({ length: 14 }, (_, i) => ({ uuid: `u-${i}`, workflow_id: `w-${i}`, workflow_label: `Flow ${i}` }));
  stubFetch({ ...ROUTES, [`${API}/organization/org-1/application/app-1/verification-settings/`]: { results } });
  const err = await threw(() => inContext("lbl-5", () => resolveWorkflowScope("nope", "org-1", "app-1")));

  assert.equal((err.shape.hint.match(/→ w-\d+/g) ?? []).length, 10);
});

test("label resolution: a real uuid that exists nowhere keeps the original not-found error", async () => {
  stubFetch(ROUTES);
  const err = await threw(() => inContext("lbl-6", () => resolveWorkflowScope(MISSING_UUID)));

  assert.notEqual(err?.name, "DiditError");
  assert.match(err.message, /was not found in any of your applications/);
});

test("field_definitions: a resolved label is reported back on the result", async () => {
  stubFetch(ROUTES);
  const result = await inContext("lbl-7", () => getWorkflowFieldDefinitions("adaptive-age-estimation"));

  assert.deepEqual(result.workflow_resolved, {
    from: "adaptive-age-estimation",
    workflow_id: "stable-1",
    label: "Adaptive Age Estimation",
  });
  assert.deepEqual(result.fields_by_feature, {});
});

test("field_definitions: a uuid id carries no resolution note", async () => {
  stubFetch(ROUTES);
  const result = await inContext("lbl-8", () => getWorkflowFieldDefinitions("v-2", { organization_id: "org-1", application_id: "app-1" }));

  assert.equal(result.workflow_resolved, undefined);
});

test("compliance_check_workflow: a label resolves and the backend receives the workflow id", async () => {
  const calls = stubFetch(ROUTES);
  const result = await inContext("lbl-9", () => checkWorkflow({ workflow_id: "Adaptive Age Estimation", as_of: "2026-09-04" }));

  const check = calls.find((c) => c.path.endsWith("/compliance/workflow-check/"));
  assert.deepEqual(check.body, { workflow_id: "stable-1", as_of: "2026-09-04" });
  assert.equal(result.workflow_resolved.workflow_id, "stable-1");
});

test("compliance_check_workflow: a version uuid is sent as-is (an older version stays selectable)", async () => {
  const calls = stubFetch(ROUTES);
  await inContext("lbl-10", () => checkWorkflow({ workflow_id: "v-2", organization_id: "org-1", application_id: "app-1" }));

  const check = calls.find((c) => c.path.endsWith("/compliance/workflow-check/"));
  assert.deepEqual(check.body, { workflow_id: "v-2" });
});

const GRAPH = { start_node: "ocr", nodes: { ocr: { node_type: "feature", feature: "OCR", next: "b" }, b: { node_type: "branch", branches: [] } } };

test("branch_fields: missing branch_node_id fails fast with a bad_request naming both inputs", async () => {
  const calls = stubFetch(ROUTES);
  const err = await threw(() => inContext("lbl-11", () => getWorkflowBranchFields("v-1", GRAPH, undefined)));

  assert.equal(err?.shape?.code, "bad_request");
  assert.equal(err.shape.field, "branch_node_id");
  assert.match(err.message, /Both 'graph' and 'branch_node_id' are required/);
  assert.match(err.shape.hint, /didit_workflow_get_graph/);
  assert.equal(calls.length, 0);
});

test("branch_fields: a graph without nodes is rejected before any request", async () => {
  const calls = stubFetch(ROUTES);
  const err = await threw(() => inContext("lbl-12", () => getWorkflowBranchFields("v-1", undefined, "b")));

  assert.equal(err?.shape?.field, "graph");
  assert.equal(calls.length, 0);
});

test("branch_fields: posts branch_node_id (the key the backend reads), not node_id", async () => {
  const calls = stubFetch({
    ...ROUTES,
    [`${API}/organization/org-1/application/app-1/verification-settings/v-1/workflow-graph/branch-fields/`]: { fields: [] },
  });
  await inContext("lbl-13", () => getWorkflowBranchFields("v-1", GRAPH, "b", { organization_id: "org-1", application_id: "app-1" }));

  const post = calls.find((c) => c.path.endsWith("/workflow-graph/branch-fields/"));
  assert.equal(post.method, "POST");
  assert.equal(post.body.branch_node_id, "b");
  assert.equal("node_id" in post.body, false);
  assert.deepEqual(Object.keys(post.body.graph.nodes), ["ocr", "b"]);
});

test("label resolution: an incomplete scan keeps the not-found caveat instead of claiming no such label", async () => {
  stubFetch({
    ...ROUTES,
    [`${API}/organization/org-1/application/app-2/verification-settings/`]: () => json({ detail: "Server error." }, 500),
  });
  const err = await threw(() => inContext("lbl-14", () => resolveWorkflowScope("some-other-flow")));

  assert.match(err.message, /was not found in any of your applications/);
  assert.match(err.message, /1 application\(s\) returned errors and could not be scanned/);
});
