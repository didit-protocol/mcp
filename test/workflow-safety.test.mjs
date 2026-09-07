import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { getQuestionnaire } from "../dist/tools/questionnaires.js";
import { deleteWorkflow, updateWorkflow } from "../dist/tools/settings.js";
import {
  getWorkflowFieldDefinitions,
  validateWorkflowGraph,
} from "../dist/tools/workflow-graph.js";

const API = "https://verification.didit.me/v3";
const APP = `${API}/organization/org-1/application/app-1`;
const SCOPE = { organization_id: "org-1", application_id: "app-1" };
const inApp = (token, fn) =>
  requestContext.run(
    { accessToken: token, organizationId: "org-1", applicationId: "app-1" },
    fn,
  );
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function method(init) {
  return String(init?.method ?? "GET").toUpperCase();
}

test("updating a draft label preserves draft status when status is omitted", async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: method(init), body: init.body ? JSON.parse(init.body) : null });
    if (method(init) === "GET") return json({ uuid: "wf-draft", status: "draft" });
    return json({ uuid: "wf-draft", status: "draft", workflow_label: "Renamed" });
  };

  const result = await inApp("tok-update", () =>
    updateWorkflow("wf-draft", { workflow_label: "Renamed" }),
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, { workflow_label: "Renamed", status: "draft" });
  assert.equal(result.status, "draft");
});

test("an undeletable only workflow is archived without changing publication state", async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: method(init), body: init.body ? JSON.parse(init.body) : null };
    requests.push(call);
    if (call.method === "DELETE") return json({ detail: "Cannot delete the only version. Archive it instead." }, 400);
    if (call.method === "GET") return json({ uuid: "wf-only", status: "draft", is_archived: false });
    return json({ uuid: "wf-only", status: "draft", is_archived: true });
  };

  const result = await inApp("tok-delete", () => deleteWorkflow("wf-only"));

  assert.deepEqual(requests.map((request) => request.method), ["DELETE", "GET", "PATCH"]);
  assert.deepEqual(requests[2].body, { is_archived: true, status: "draft" });
  assert.equal(result.archived, true);
  assert.equal(result.deleted, false);
});

test("validate graph summarizes large feature config by default", async () => {
  const graph = {
    start_node: "ocr",
    nodes: {
      ocr: {
        node_type: "feature",
        feature: "OCR",
        config: { documents_allowed: { ESP: { ID: { enabled: 1, padding: "x".repeat(900) } } } },
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    if (method(init) === "GET") return json({ uuid: "wf-1", status: "draft" });
    return json({ is_valid: true, graph });
  };

  const result = await inApp("tok-validate", () =>
    validateWorkflowGraph("wf-1", graph, SCOPE, false),
  );

  assert.equal(result.is_valid, true);
  assert.equal(result.config_summarized, true);
  assert.equal(result.graph.nodes.ocr.config.documents_allowed._omitted, true);
});

test("field definitions can be filtered to one feature", async () => {
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("field-definitions")) {
      return json({
        fields: [{ field: "kyc.status" }, { field: "aml.status" }],
        fields_by_feature: {
          OCR: [{ field: "kyc.status" }],
          AML: [{ field: "aml.status" }],
        },
        operators_by_field_type: { status: ["equals"] },
      });
    }
    return json({ uuid: "wf-1", status: "draft" });
  };

  const result = await inApp("tok-fields", () =>
    getWorkflowFieldDefinitions("wf-1", { ...SCOPE, feature: "ocr" }),
  );

  assert.deepEqual(result, {
    feature: "OCR",
    fields: [{ field: "kyc.status" }],
    operators_by_field_type: { status: ["equals"] },
    filtered: true,
  });
});

test("questionnaire get summarizes translations unless explicitly requested", async () => {
  globalThis.fetch = async () =>
    json({
      uuid: "q-1",
      title: { en: "Identity", es: "Identidad" },
      graph: {
        nodes: {
          q1: {
            element_type: "SHORT_TEXT",
            title: { en: "Name", es: "Nombre" },
          },
        },
      },
    });

  const result = await inApp("tok-questionnaire", () => getQuestionnaire("q-1"));

  assert.deepEqual(result.title, { en: "Identity" });
  assert.deepEqual(result.graph.nodes.q1.title, { en: "Name" });
  assert.equal(result.translations_summarized, true);
});
