import { test } from "node:test";
import assert from "node:assert/strict";
import {
  editWorkflowGraph,
  validateWorkflowGraph,
} from "../dist/tools/workflow-graph.js";
import { requestContext } from "../dist/config.js";

const API = "https://verification.didit.me/v3";
const APP_BASE = `${API}/organization/org-1/application/app-1`;
const SCOPE = { organization_id: "org-1", application_id: "app-1" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const inContext = (token, fn) => requestContext.run({ accessToken: token }, fn);

function nfcGraph(rule) {
  return {
    start_node: "nfc",
    nodes: {
      nfc: { node_type: "feature", feature: "NFC", next: "reason" },
      reason: {
        node_type: "branch",
        branches: [
          { id: "skip", logic: "and", rules: [rule], goto: "review" },
          { id: "else", logic: "and", rules: [], goto: "approve" },
        ],
      },
      review: { node_type: "status", session_status: "In Review" },
      approve: { node_type: "status", session_status: "Approved" },
    },
  };
}

test("validate preserves an nfc.skip_reason equals scalar in the backend payload", async () => {
  const rule = {
    field: "nfc.skip_reason",
    operator: "equals",
    value: "DEVICE_WITHOUT_NFC",
    node_id: "nfc",
  };
  const graph = nfcGraph(rule);
  let validationBody;

  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    if (path === `${APP_BASE}/verification-settings/wf-equals/`) {
      return json({ uuid: "wf-equals", status: "draft" });
    }
    if (path === `${APP_BASE}/workflow-graph/validate/`) {
      validationBody = JSON.parse(init.body);
      return json({ is_valid: true });
    }
    return json({ detail: "Not found." }, 404);
  };

  const result = await inContext("tok-nfc-equals", () =>
    validateWorkflowGraph("wf-equals", graph, SCOPE),
  );

  assert.deepEqual(result, { is_valid: true });
  assert.deepEqual(validationBody, { graph, workflow_uuid: "wf-equals" });
  assert.deepEqual(validationBody.graph.nodes.reason.branches[0].rules[0], rule);
});

test("set_branches preserves an nfc.skip_reason in-array through fetch, validate, and save", async () => {
  const original = nfcGraph({
    field: "nfc.skip_reason",
    operator: "equals",
    value: "DEVICE_WITHOUT_NFC",
    node_id: "nfc",
  });
  const values = ["DEVICE_WITHOUT_NFC", "DOCUMENT_WITHOUT_CHIP"];
  const branches = [
    {
      id: "skip",
      logic: "and",
      rules: [{ field: "nfc.skip_reason", operator: "in", value: values, node_id: "nfc" }],
      goto: "review",
    },
    { id: "else", logic: "and", rules: [], goto: "approve" },
  ];
  let validationBody;
  let savedBody;

  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    if (path === `${APP_BASE}/verification-settings/wf-edit/`) {
      return json({ uuid: "wf-edit", status: "draft" });
    }
    if (path === `${APP_BASE}/verification-settings/wf-edit/workflow-graph/` && init.method === "GET") {
      return json({ graph: original });
    }
    if (path === `${APP_BASE}/workflow-graph/validate/`) {
      validationBody = JSON.parse(init.body);
      return json({ is_valid: true });
    }
    if (path === `${APP_BASE}/verification-settings/wf-edit/workflow-graph/` && init.method === "PUT") {
      savedBody = JSON.parse(init.body);
      return json(savedBody);
    }
    return json({ detail: "Not found." }, 404);
  };

  const result = await inContext("tok-nfc-edit", () =>
    editWorkflowGraph("wf-edit", [{ op: "set_branches", node_id: "reason", branches }], false, SCOPE),
  );

  assert.equal(result.applied, true);
  assert.deepEqual(validationBody.graph.nodes.reason.branches, branches);
  assert.deepEqual(savedBody.graph.nodes.reason.branches, branches);
  assert.deepEqual(savedBody.graph.nodes.reason.branches[0].rules[0].value, values);
});

test("an invalid NFC reason returns backend validation and never saves", async () => {
  const graph = nfcGraph({
    field: "nfc.skip_reason",
    operator: "equals",
    value: "NOT_A_REAL_REASON",
    node_id: "nfc",
  });
  const backendValidation = {
    is_valid: false,
    errors: {
      reason: [
        {
          field: "nfc.skip_reason",
          message: "Invalid NFC skip reason: NOT_A_REAL_REASON",
        },
      ],
    },
  };
  let saveCalls = 0;

  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    if (path === `${APP_BASE}/verification-settings/wf-invalid/`) {
      return json({ uuid: "wf-invalid", status: "draft" });
    }
    if (path === `${APP_BASE}/verification-settings/wf-invalid/workflow-graph/` && init.method === "GET") {
      return json({ graph });
    }
    if (path === `${APP_BASE}/workflow-graph/validate/`) return json(backendValidation);
    if (path === `${APP_BASE}/verification-settings/wf-invalid/workflow-graph/` && init.method === "PUT") {
      saveCalls += 1;
      return json({ graph });
    }
    return json({ detail: "Not found." }, 404);
  };

  const result = await inContext("tok-nfc-invalid", () =>
    editWorkflowGraph(
      "wf-invalid",
      [{
        op: "set_branches",
        node_id: "reason",
        branches: graph.nodes.reason.branches,
      }],
      false,
      SCOPE,
    ),
  );

  assert.equal(result.applied, false);
  assert.deepEqual(result.validation, backendValidation);
  assert.equal(saveCalls, 0);
});
