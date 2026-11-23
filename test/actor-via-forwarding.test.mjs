import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONNAIRE_TOOLS } from "../dist/tools/questionnaires.js";
import { requestContext } from "../dist/config.js";
import { editWorkflowGraph } from "../dist/tools/workflow-graph.js";

// an internal issue (child of an internal issue): the console assistant sends X-Didit-Actor-Via: copilot on every
// MCP request, and the backend audit log can only mark a write as assistant-initiated if the MCP
// server passes it on. It did so only for the Investigator tools; every other tool call went out
// without it. The forwarding lives in apiRequest, so no tool has to remember it.

const BASE = { accessToken: "t-1", organizationId: "org-1", applicationId: "app-1" };

function createTool() {
  const found = QUESTIONNAIRE_TOOLS.find((entry) => entry.def.name === "didit_questionnaire_create");
  assert.ok(found, "didit_questionnaire_create is registered");
  return found;
}

function interceptFetch(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ method: init.method ?? "GET", headers: init.headers ?? {} });
    return Response.json({ questionnaire_id: "q-1" }, { status: 201 });
  });
  return calls;
}

const create = (ctx) =>
  requestContext.run({ ...BASE, ...ctx }, () => createTool().run({ title: "Acme onboarding", form_elements: [{ element_type: "SHORT_TEXT", title: "Name" }] }));

const actorVia = (call) => call.headers["X-Didit-Actor-Via"];

test("a write tool forwards X-Didit-Actor-Via: copilot when the incoming request carried it", async (t) => {
  const calls = interceptFetch(t);
  await create({ actorVia: "copilot" });
  const writes = calls.filter((call) => call.method === "POST");
  assert.ok(writes.length >= 1, "the create posted");
  for (const call of calls) assert.equal(actorVia(call), "copilot");
});

test("a call without the incoming header sends no X-Didit-Actor-Via", async (t) => {
  const calls = interceptFetch(t);
  await create({});
  assert.ok(calls.length >= 1);
  for (const call of calls) assert.equal(actorVia(call), undefined);
});

test("an incoming value that is not copilot is forwarded as mcp", async (t) => {
  const calls = interceptFetch(t);
  await create({ actorVia: "mcp" });
  assert.ok(calls.length >= 1);
  for (const call of calls) assert.equal(actorVia(call), "mcp");
});

// Workflow writes run inside runForScope, which opens a new request context for the resolved
// (organization, application). It used to drop actorVia, so the draft create and the graph save
// went out unmarked.
const APP_PATH = "/organization/org-1/application/app-1";
const GRAPH = { start_node: "approved", nodes: { approved: { node_type: "status", session_status: "Approved" } } };

function interceptWorkflowFetch(t) {
  const calls = [];
  const routes = {
    [`GET ${APP_PATH}/verification-settings/stable/`]: () => Response.json({ detail: "Not found." }, { status: 404 }),
    [`GET ${APP_PATH}/verification-settings/`]: { results: [{ uuid: "pub", workflow_id: "stable", status: "published", has_draft: false, version: 1 }] },
    [`GET ${APP_PATH}/verification-settings/pub/workflow-graph/`]: { graph: GRAPH },
    [`POST ${APP_PATH}/verification-settings/pub/create-draft/`]: { uuid: "dft", status: "draft" },
    [`POST ${APP_PATH}/workflow-graph/validate/`]: { is_valid: true },
    [`GET ${APP_PATH}/verification-settings/dft/workflow-graph/`]: { graph: GRAPH },
    [`PUT ${APP_PATH}/verification-settings/dft/workflow-graph/`]: { graph: GRAPH },
  };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const method = init.method ?? "GET";
    const pathname = new URL(String(url)).pathname;
    const path = pathname.slice(pathname.indexOf("/organization/"));
    calls.push({ method, path, headers: init.headers ?? {} });
    const handler = routes[`${method} ${path}`];
    if (!handler) return Response.json({ detail: "Not found." }, { status: 404 });
    return typeof handler === "function" ? handler() : Response.json(handler);
  });
  return calls;
}

const editGraph = (ctx) =>
  requestContext.run({ accessToken: "t-1", ...ctx }, () =>
    editWorkflowGraph("stable", [{ op: "set_start", start_node: "approved" }], false, { organization_id: "org-1", application_id: "app-1" }));

test("a workflow graph save forwards X-Didit-Actor-Via: copilot through the scope switch", async (t) => {
  const calls = interceptWorkflowFetch(t);
  await editGraph({ actorVia: "copilot" });
  const writes = calls.filter((call) => call.method === "PUT" || (call.method === "POST" && call.path.endsWith("/create-draft/")));
  assert.equal(writes.length, 2, "the draft create and the graph save were sent");
  for (const call of calls.filter((c) => c.path.startsWith(APP_PATH))) assert.equal(actorVia(call), "copilot", `${call.method} ${call.path}`);
});

test("a workflow graph save without the incoming header sends none", async (t) => {
  const calls = interceptWorkflowFetch(t);
  await editGraph({});
  assert.ok(calls.some((call) => call.method === "PUT"));
  for (const call of calls) assert.equal(actorVia(call), undefined);
});
