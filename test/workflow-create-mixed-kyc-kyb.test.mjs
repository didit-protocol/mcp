// A mixed KYC/KYB feature list must not create anything.
//
// The backend fixes `workflow_type` when a workflow is CREATED and refuses to change it
// afterwards ("Workflow type cannot be changed once it has been set"), and its
// validate_kyc_kyb_segregation rejects person-only steps on a workflow whose DECLARED type is
// kyb, regardless of what the replacement graph contains. So a create that POSTs the draft
// first and only then notices the mix leaves behind a draft permanently typed kyb, and the
// pure-KYC recovery it advises is impossible to carry out (an internal issue, retrospective review of
// mcp-server PR #89). The check therefore runs BEFORE the POST: nothing is created, and the
// caller is told to call didit_workflow_create again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { createWorkflow } from "../dist/tools/settings.js";
import { setWorkflowGraph } from "../dist/tools/workflow-graph.js";
import { buildLinearGraphFromFeatures } from "../dist/tools/feature-config.js";

const API = "https://verification.didit.me/v3";
const APP = `${API}/organization/org-1/application/app-1`;
const SCOPE = { organization_id: "org-1", application_id: "app-1" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const inApp = (fn) =>
  requestContext.run(
    { accessToken: "tok-mixed", organizationId: "org-1", applicationId: "app-1" },
    fn,
  );

const KYB_COMPATIBLE = new Set([
  "KYB_REGISTRY", "KYB_DOCUMENTS", "KYB_KEY_PEOPLE",
  "AML", "QUESTIONNAIRE", "PHONE_VERIFICATION", "EMAIL_VERIFICATION", "IP_ANALYSIS", "DOCUMENT_AI",
  "BANK_VERIFICATION",
]);

/**
 * A backend that behaves like the real one on the two rules this regression is about:
 *   - workflow_type is accepted on POST and immutable afterwards;
 *   - a graph write is validated against the STORED declared type, so person-only features are
 *     rejected on a kyb workflow even when the new graph carries no KYB feature at all.
 * Everything else (validate, graph PUT, publish) succeeds.
 */
function fakeBackend(seed = {}) {
  const state = { workflows: new Map(Object.entries(seed)), requests: [], nextId: 1 };

  const personOnly = (graph) =>
    Object.values(graph?.nodes ?? {})
      .filter((node) => node?.node_type === "feature" && typeof node.feature === "string")
      .map((node) => node.feature.toUpperCase())
      .filter((feature) => !KYB_COMPATIBLE.has(feature));

  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    const method = String(init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ path, method, body });

    if (path === `${APP}/verification-settings/` && method === "POST") {
      const uuid = `wf-${state.nextId++}`;
      const workflow = { uuid, workflow_id: uuid, status: "draft", ...body };
      state.workflows.set(uuid, workflow);
      return json(workflow);
    }
    const version = path.match(new RegExp(`^${APP}/verification-settings/([^/]+)/(workflow-graph/)?$`));
    if (version) {
      const workflow = state.workflows.get(version[1]);
      if (!workflow) return json({ detail: "Not found." }, 404);
      const isGraph = Boolean(version[2]);
      if (isGraph && method === "PUT") {
        const rejected = workflow.workflow_type === "kyb" ? personOnly(body.graph) : [];
        if (rejected.length > 0) {
          return json(
            {
              detail:
                "A business (KYB) workflow cannot also run person/KYC-only features: " +
                `${rejected.sort().join(", ")}.`,
            },
            400,
          );
        }
        workflow.graph = body.graph;
        return json({ graph: body.graph });
      }
      if (isGraph && method === "GET") return json({ graph: workflow.graph ?? null });
      if (!isGraph && method === "GET") return json(workflow);
      if (!isGraph && method === "PATCH") {
        if (body.workflow_type !== undefined && body.workflow_type !== workflow.workflow_type) {
          return json({ detail: "Workflow type cannot be changed once it has been set." }, 400);
        }
        Object.assign(workflow, body);
        return json(workflow);
      }
    }
    if (path === `${APP}/workflow-graph/validate/` && method === "POST") return json({ is_valid: true });
    return json({ detail: `Not found: ${method} ${path}` }, 404);
  };
  return state;
}

test("a mixed KYC/KYB feature list creates NOTHING and is not offered a set_graph repair", async () => {
  const state = fakeBackend();

  const result = await inApp(() =>
    createWorkflow({
      workflow_label: "Mixed",
      status: "draft",
      features: [{ feature: "KYB_REGISTRY" }, { feature: "OCR" }],
    }),
  );

  // No draft was created, so no draft was permanently typed kyb.
  assert.deepEqual(state.requests, []);
  assert.equal(state.workflows.size, 0);
  assert.equal(result.created, false);
  assert.equal(result.graph_applied, false);
  assert.equal(result.workflow_id, undefined);
  assert.equal(result.validation.is_valid, false);
  assert.match(result.validation.error, /person\/KYC-only/);
  // The recovery instruction is a NEW create, never a repair of a draft that does not exist.
  assert.match(result.note, /NOTHING WAS CREATED/);
  assert.match(result.note, /didit_workflow_create again/);
  assert.doesNotMatch(result.note, /didit_workflow_set_graph and publish/);
});

test("the advised recovery works: a pure-KYC create after a mixed rejection applies its graph", async () => {
  const state = fakeBackend();

  await inApp(() =>
    createWorkflow({ workflow_label: "Mixed", status: "draft", features: [{ feature: "KYB_REGISTRY" }, { feature: "OCR" }] }),
  );
  const recovered = await inApp(() =>
    createWorkflow({ workflow_label: "KYC only", status: "draft", features: [{ feature: "OCR" }] }),
  );

  assert.equal(recovered.created, true);
  assert.equal(recovered.graph_applied, true);
  assert.equal(recovered.status, "draft");
  assert.equal(state.workflows.get(recovered.workflow_id).workflow_type, undefined);
  assert.ok(state.workflows.get(recovered.workflow_id).graph);
});

test("the old recovery path is genuinely impossible: an OCR graph on a kyb draft is rejected", async () => {
  // Guards the stub itself: with a draft already typed kyb (what the pre-fix create left behind)
  // the advised pure-KYC repair fails on the backend's declared-type rule, and retyping is refused.
  const state = fakeBackend({ "wf-kyb": { uuid: "wf-kyb", workflow_id: "wf-kyb", status: "draft", workflow_type: "kyb" } });

  await assert.rejects(
    () => inApp(() => setWorkflowGraph("wf-kyb", buildLinearGraphFromFeatures([{ feature: "OCR" }]), false, SCOPE)),
    /person\/KYC-only features: OCR/,
  );
  assert.equal(state.workflows.get("wf-kyb").graph, undefined);
});

test("pure-KYB creation still types the draft kyb, applies the graph and publishes", async () => {
  const state = fakeBackend();

  const result = await inApp(() =>
    createWorkflow({
      workflow_label: "Company onboarding",
      features: [{ feature: "KYB_REGISTRY" }, { feature: "AML" }],
    }),
  );

  const workflow = state.workflows.get(result.workflow_id);
  assert.equal(workflow.workflow_type, "kyb");
  assert.ok(workflow.graph);
  assert.equal(result.graph_applied, true);
  assert.equal(result.status, "published");
  assert.equal(workflow.status, "published");
  assert.deepEqual(result.features, ["KYB_REGISTRY", "AML"]);
});

test("a featureless create still makes an empty draft", async () => {
  const state = fakeBackend();

  const result = await inApp(() => createWorkflow({ workflow_label: "Empty", status: "draft" }));

  assert.equal(result.created, true);
  assert.equal(result.graph_applied, false);
  assert.equal(result.status, "draft");
  assert.equal(state.workflows.size, 1);
});
