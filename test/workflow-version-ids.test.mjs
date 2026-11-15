import { test } from "node:test";
import assert from "node:assert/strict";
import { searchWorkflows } from "../dist/tools/search.js";
import { publishWorkflow } from "../dist/tools/workflow-graph.js";
import { WORKFLOW_TOOLS } from "../dist/tools/workflows.js";
import { SESSION_TOOLS } from "../dist/tools/sessions.js";
import { runForScope } from "../dist/orgapp.js";
import { requestContext } from "../dist/config.js";

/**
 * WHICH workflow id an integration uses.
 *
 * Prod 12/13-nov (thread 4c13bafe): asked for the workflow ID to integrate, the
 * agent gave the `uuid` of a didit_workflow_search row — the uuid of version 2
 * — and the customer's app kept running v2 for two days after v4 and v5 were
 * published: a session created with a version uuid pins that exact version. The
 * rows carried `uuid` and `workflow_id` side by side with nothing saying which
 * one integrations use, and a superseded version still says status "published".
 */

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";
const APP = `${API}/organization/org-1/application/app-1`;
const SCOPE = { organization_id: "org-1", application_id: "app-1" };
const STABLE = "2a1b6e87-0000-4000-8000-000000000001";
const OLD = "e672b5fe-0000-4000-8000-000000000002";
const LIVE = "5b0c1d2e-0000-4000-8000-000000000005";
const DRAFT = "6c1d2e3f-0000-4000-8000-000000000006";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ROUTES = {
  [`GET ${AUTH}/organizations/me/`]: [{ uuid: "org-1", name: "Org One" }],
  [`GET ${AUTH}/organizations/me/org-1/applications/`]: [{ uuid: "app-1", name: "App One" }],
  // The list shows one row per workflow: its live (latest published) version.
  [`GET ${APP}/verification-settings/`]: {
    results: [{ uuid: LIVE, workflow_id: STABLE, status: "published", version: 5, has_draft: true, workflow_label: "KYC" }],
  },
  // A superseded version still reads "published" on its own.
  [`GET ${APP}/verification-settings/${OLD}/`]: { uuid: OLD, workflow_id: STABLE, status: "published", version: 2 },
  [`GET ${APP}/verification-settings/${LIVE}/`]: { uuid: LIVE, workflow_id: STABLE, status: "published", version: 5 },
  [`GET ${APP}/verification-settings/${STABLE}/versions/`]: {
    results: [
      { uuid: DRAFT, workflow_id: STABLE, status: "draft", version: 6 },
      { uuid: LIVE, workflow_id: STABLE, status: "published", version: 5 },
      { uuid: OLD, workflow_id: STABLE, status: "published", version: 2 },
    ],
  },
  [`POST ${APP}/verification-settings/${LIVE}/create-draft/`]: { uuid: DRAFT, status: "draft" },
  [`PATCH ${APP}/verification-settings/${DRAFT}/`]: { uuid: DRAFT, status: "published" },
};

const stubFetch = (routes) => {
  globalThis.fetch = async (url, init = {}) => {
    const handler = routes[`${init.method ?? "GET"} ${String(url).split("?")[0]}`];

    return handler ? json(handler) : json({ detail: "Not found." }, 404);
  };
};

// Distinct token per test — getOrgAppMap caches the org/app map per access token.
const inContext = (token, fn) => requestContext.run({ accessToken: token }, fn);

const toolNamed = (tools, name) => tools.find((tool) => tool.def.name === name);

const getTool = toolNamed(WORKFLOW_TOOLS, "didit_workflow_get");

test("a search row labels the stable workflow_id and its live version", async () => {
  stubFetch(ROUTES);
  const found = await inContext("ids-search", () => searchWorkflows({ workflow_id: STABLE }));
  const [row] = found.results;

  assert.equal(row.workflow_id, STABLE);
  assert.equal(row.version_uuid, LIVE);
  assert.equal(row.is_live_version, true);
  assert.match(found.ids_note, /workflow_id/);
  assert.match(found.ids_note, /version_uuid/);
});

test("a search for a superseded version uuid flags it as not live", async () => {
  stubFetch(ROUTES);
  const found = await inContext("ids-old", () => searchWorkflows({ workflow_id: OLD }));
  const [row] = found.results;

  assert.equal(row.version_uuid, OLD);
  assert.equal(row.workflow_id, STABLE);
  assert.equal(row.is_live_version, false, "status 'published' alone does not make a version live");
});

test("didit_workflow_list in one application labels its rows like a search", async () => {
  stubFetch(ROUTES);
  const listTool = toolNamed(WORKFLOW_TOOLS, "didit_workflow_list");
  const page = await inContext("ids-list", () => runForScope("org-1", "app-1", () => listTool.run({})));
  const [row] = page.results;

  assert.equal(row.workflow_id, STABLE);
  assert.equal(row.version_uuid, LIVE);
  assert.equal(row.is_live_version, true);
  assert.match(page.ids_note, /workflow_id/);
});

test("didit_workflow_get labels the version and says whether it is the live one", async () => {
  stubFetch(ROUTES);
  const old = await inContext("ids-get", () => runForScope("org-1", "app-1", () => getTool.run({ workflow_id: OLD })));
  const live = await inContext("ids-get", () => runForScope("org-1", "app-1", () => getTool.run({ workflow_id: LIVE })));

  assert.equal(old.version_uuid, OLD);
  assert.equal(old.workflow_id, STABLE);
  assert.equal(old.is_live_version, false);
  assert.equal(live.is_live_version, true);
  assert.match(old.ids_note, /workflow_id/);
});

test("a publish result labels the stable workflow_id next to the version it made live", async () => {
  stubFetch(ROUTES);
  const result = await inContext("ids-publish", () => publishWorkflow(STABLE, SCOPE));

  assert.equal(result.workflow_id, STABLE);
  assert.equal(result.version_uuid, DRAFT);
  assert.equal(result.is_live_version, true);
  assert.match(result.ids_note, /workflow_id/);
});

test("the tool contracts say which id integrations and sessions use", () => {
  const sessionWorkflowId = toolNamed(SESSION_TOOLS, "didit_session_create").def.inputSchema.properties.workflow_id.description;
  const search = toolNamed(WORKFLOW_TOOLS, "didit_workflow_search").def.description;

  assert.match(sessionWorkflowId, /stable workflow_id/i);
  assert.match(sessionWorkflowId, /pins/i);
  assert.match(search, /version_uuid/);
  assert.match(search, /is_live_version/);
});
