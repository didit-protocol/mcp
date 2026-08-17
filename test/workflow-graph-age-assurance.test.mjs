import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateAgeAssurance, getWorkflowGraph } from "../dist/tools/workflow-graph.js";
import { requestContext } from "../dist/config.js";

const APP_BASE = "https://verification.didit.me/v3/organization/org-1/application/app-1";
const SCOPE = { organization_id: "org-1", application_id: "app-1" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Serve one workflow: its settings detail (response_attributes) and its graph. */
const stubWorkflow = (uuid, graph) => {
  const routes = {
    [`${APP_BASE}/verification-settings/${uuid}/`]: { uuid, response_attributes: null },
    [`${APP_BASE}/verification-settings/${uuid}/workflow-graph/`]: { graph, status: "published" },
  };

  globalThis.fetch = async (url) => json(routes[String(url).split("?")[0]] ?? { detail: "Not found." });
};

const inContext = (token, fn) => requestContext.run({ accessToken: token }, fn);

const read = (uuid, graph, token) => {
  stubWorkflow(uuid, graph);

  return inContext(token, () => getWorkflowGraph(uuid, SCOPE));
};

// The incident (2026-08-17): asked what the relying party receives "in the age assurance
// workflows", the agent searched the LABEL, found none, and answered for an onboarding KYC
// workflow instead. Age verification from a document is age assurance and lives in the OCR
// node's config — no AGE_ESTIMATION feature and no telling name anywhere.
test("a KYC-named workflow with document age restrictions does age assurance", async () => {
  const graph = {
    start_node: "a",
    nodes: { a: { node_type: "feature", feature: "OCR", config: { is_age_restrictions_enabled: true } } },
  };
  const res = await read("wf-aa-1", graph, "tok-aa-1");

  assert.deepEqual(res.age_assurance.methods, ["age_verification"]);
  assert.equal(res.age_assurance.signals.ocr_age_restrictions, true);
  assert.match(res.age_assurance.semantics, /never from the workflow's name/);
});

test("the AGE_ESTIMATION feature reports age estimation", async () => {
  const graph = {
    start_node: "a",
    nodes: { a: { node_type: "feature", feature: "AGE_ESTIMATION" } },
  };
  const res = await read("wf-aa-2", graph, "tok-aa-2");

  assert.deepEqual(res.age_assurance.methods, ["age_estimation"]);
});

test("a branch on kyc.age counts even without the OCR flag", async () => {
  const graph = {
    start_node: "b",
    nodes: {
      b: { node_type: "branch", branches: [{ id: "adult", rules: [{ field: "kyc.age", operator: "gte", value: 18 }] }] },
    },
  };
  const res = await read("wf-aa-3", graph, "tok-aa-3");

  assert.deepEqual(res.age_assurance.methods, ["age_verification"]);
  assert.deepEqual(res.age_assurance.signals.age_conditions, ["kyc.age"]);
});

test("a workflow that never checks age reports no methods", async () => {
  const graph = {
    start_node: "a",
    nodes: {
      a: { node_type: "feature", feature: "OCR", config: { is_age_restrictions_enabled: false } },
      b: { node_type: "branch", branches: [{ id: "x", rules: [{ field: "kyc.first_name", operator: "eq", value: "A" }] }] },
    },
  };
  const res = await read("wf-aa-4", graph, "tok-aa-4");

  assert.deepEqual(res.age_assurance.methods, []);
  assert.equal(res.age_assurance.does_age_assurance, false);
  assert.match(res.age_assurance.semantics, /tell them they have none/);
  assert.deepEqual(res.age_assurance.signals.age_conditions, []);
});

test("both methods are reported when the workflow does document AND selfie age checks", async () => {
  const graph = {
    start_node: "a",
    nodes: {
      a: { node_type: "feature", feature: "OCR", config: { is_age_restrictions_enabled: true } },
      b: { node_type: "feature", feature: "AGE_ESTIMATION" },
    },
  };
  const res = await read("wf-aa-5", graph, "tok-aa-5");

  assert.deepEqual(res.age_assurance.methods, ["age_verification", "age_estimation"]);
});

// An unreadable graph must not deny the capability: "does_age_assurance: false"
// on missing data is the permissive-default trap with the opposite sign.
test("an unreadable graph reports unavailable, never 'does not do age assurance'", async () => {
  const res = await read("wf-aa-6", null, "tok-aa-6");

  assert.equal(res.age_assurance.unavailable, true);
  assert.equal("does_age_assurance" in res.age_assurance, false);
});

// 2026-08-17, real account: asked which workflows do age assurance, the agent read the
// LIST — which carries `features` but no graph — preselected the AGE_ESTIMATION rows and
// concluded "3 workflows, all through AGE_ESTIMATION", silently missing the KYC workflow
// that checks age from the document. The annotation is what makes that row visible.
test("the list annotation finds the document-route workflow the features hide", async () => {
  const graphs = {
    "wf-doc": { start_node: "a", nodes: { a: { node_type: "feature", feature: "OCR", config: { is_age_restrictions_enabled: true } } } },
    "wf-est": { start_node: "a", nodes: { a: { node_type: "feature", feature: "AGE_ESTIMATION" } } },
    "wf-none": { start_node: "a", nodes: { a: { node_type: "feature", feature: "OCR" } } },
  };

  globalThis.fetch = async (url) => {
    const uuid = String(url).split("/verification-settings/")[1]?.split("/")[0];

    return json({ graph: graphs[uuid] });
  };

  const payload = {
    results: [
      // Rows arrive tagged with their org/app, the way the cross-app aggregate returns them.
      { uuid: "wf-doc", ...SCOPE, features: ["OCR", "LIVENESS"], is_archived: false },
      { uuid: "wf-est", ...SCOPE, features: ["AGE_ESTIMATION"], is_archived: false },
      { uuid: "wf-none", ...SCOPE, features: ["OCR"], is_archived: false },
      { uuid: "wf-old", ...SCOPE, features: ["AGE_ESTIMATION"], is_archived: true },
    ],
  };
  const out = await inContext("tok-aa-list", () => annotateAgeAssurance(payload));
  const by = Object.fromEntries(out.results.map((r) => [r.uuid, r]));

  assert.deepEqual(by["wf-doc"].methods, ["age_verification"]);
  assert.equal(by["wf-est"].does_age_assurance, true);
  assert.equal(by["wf-none"].does_age_assurance, false);
  // Archived rows are skipped, so they carry no verdict at all.
  assert.equal("does_age_assurance" in by["wf-old"], false);
});

test("a row whose graph cannot be read is unknown, not a denial", async () => {
  globalThis.fetch = async () => json({ detail: "boom" }, 500);
  const payload = { results: [{ uuid: "wf-x", ...SCOPE, is_archived: false }] };
  const out = await inContext("tok-aa-list-2", () => annotateAgeAssurance(payload));

  assert.equal(out.results[0].age_assurance_unavailable, true);
  assert.equal("does_age_assurance" in out.results[0], false);
});
