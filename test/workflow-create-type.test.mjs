// didit_workflow_create must TYPE the draft it creates.
//
// The backend sets `workflow_type` on create only (from the payload, or derived
// from a graph that arrives in the same payload) and refuses to change it
// afterwards. createWorkflow POSTs an empty draft and PUTs the graph later, so
// without an explicit type every KYB draft it made was a KYC workflow with
// business steps: the console validated it by KYC rules ("AML Screening
// requires ID Verification") and the user could never publish it (prod thread
// 497172a8, 2026-09-11 — the compliance onboarding's own finale goes through
// this path).

import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { createWorkflow } from "../dist/tools/settings.js";
import { workflowTypeForFeatures } from "../dist/tools/feature-config.js";

const API = "https://verification.didit.me/v3";
const APP_BASE = `${API}/organization/org-1/application/app-1`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const inContext = (fn) =>
  requestContext.run(
    { accessToken: "tok-create-type", organizationId: "org-1", applicationId: "app-1" },
    fn,
  );

/** A backend that records the create body and accepts everything after it. */
function fakeBackend() {
  const state = { created: null };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    if (path === `${APP_BASE}/verification-settings/` && method === "POST") {
      state.created = JSON.parse(init.body);
      return json({ uuid: "wf-new", status: "draft", ...state.created });
    }
    if (path === `${APP_BASE}/workflow-graph/validate/`) return json({ is_valid: true });
    if (path === `${APP_BASE}/verification-settings/wf-new/workflow-graph/`) {
      return json({ graph: JSON.parse(init.body).graph });
    }
    return json({ detail: `Not found: ${method} ${path}` }, 404);
  };
  return state;
}

test("workflowTypeForFeatures: a business-only feature declares kyb, anything else stays untyped", () => {
  assert.equal(workflowTypeForFeatures([{ feature: "KYB_REGISTRY" }]), "kyb");
  assert.equal(workflowTypeForFeatures(["kyb_key_people"]), "kyb");
  assert.equal(workflowTypeForFeatures([{ feature: "AML" }, { feature: "QUESTIONNAIRE" }]), undefined);
  assert.equal(workflowTypeForFeatures([{ feature: "OCR" }]), undefined);
  assert.equal(workflowTypeForFeatures([]), undefined);
  assert.equal(workflowTypeForFeatures(undefined), undefined);
});

test("a KYB feature list creates the draft as workflow_type kyb (the only moment the backend allows it)", async () => {
  const state = fakeBackend();
  await inContext(() =>
    createWorkflow({
      workflow_label: "Compliance onboarding (KYB)",
      features: [{ feature: "KYB_REGISTRY" }],
      status: "draft",
    }),
  );
  assert.equal(state.created.workflow_type, "kyb");
  assert.equal(state.created.status, "draft");
  // `features` is a read-only computed property on that endpoint: it must not leak.
  assert.equal("features" in state.created, false);
});

test("a KYC feature list keeps the backend's default type", async () => {
  const state = fakeBackend();
  await inContext(() =>
    createWorkflow({ workflow_label: "KYC", features: [{ feature: "OCR" }], status: "draft" }),
  );
  assert.equal("workflow_type" in state.created, false);
});
