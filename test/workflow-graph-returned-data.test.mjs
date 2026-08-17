import { test } from "node:test";
import assert from "node:assert/strict";
import { getWorkflowGraph } from "../dist/tools/workflow-graph.js";
import { requestContext } from "../dist/config.js";

const API = "https://verification.didit.me/v3";
const APP_BASE = `${API}/organization/org-1/application/app-1`;
const SCOPE = { organization_id: "org-1", application_id: "app-1" };
const GRAPH = { start_node: "a", nodes: { a: { node_type: "feature", feature: "OCR" } } };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Route fetches by exact URL path (query stripped); anything unrouted 404s like the backend. */
const stubFetch = (routes) => {
  globalThis.fetch = async (url) => {
    const handler = routes[String(url).split("?")[0]];

    if (!handler) return json({ detail: "Not found." }, 404);

    return typeof handler === "function" ? handler() : json(handler);
  };
};

// Distinct token per test — getOrgAppMap caches the org/app map per access token.
const inContext = (token, fn) => requestContext.run({ accessToken: token }, fn);

test("returned_data comes from the resolved settings detail (no extra fetch needed)", async () => {
  stubFetch({
    [`${APP_BASE}/verification-settings/wf-1/`]: {
      uuid: "wf-1",
      status: "published",
      response_attributes: { OCR: [], LIVENESS: [] },
    },
    [`${APP_BASE}/verification-settings/wf-1/workflow-graph/`]: { graph: GRAPH, status: "published" },
  });
  const res = await inContext("tok-rd-1", () => getWorkflowGraph("wf-1", SCOPE));

  assert.deepEqual(res.returned_data.response_attributes, { OCR: [], LIVENESS: [] });
  assert.match(res.returned_data.semantics, /\[\] = NONE/);
  assert.equal(res.config_summarized, true);
});

test("falls back to the settings endpoint when the resolved row lacks response_attributes", async () => {
  stubFetch({
    // The stable id resolves via the list (the direct version fetch 404s), and list rows do
    // not carry response_attributes — the fallback settings fetch must fill the gap.
    [`${APP_BASE}/verification-settings/`]: {
      results: [{ uuid: "wf-2", workflow_id: "stable-2", workflow_label: "KYC" }],
    },
    [`${APP_BASE}/verification-settings/wf-2/`]: { uuid: "wf-2", response_attributes: null },
    [`${APP_BASE}/verification-settings/wf-2/workflow-graph/`]: { graph: GRAPH },
  });
  const res = await inContext("tok-rd-2", () => getWorkflowGraph("stable-2", SCOPE));

  assert.equal(res.returned_data.response_attributes, null);
  // "All data points" is where the agent used to invent a field-by-field table (and a field
  // that does not exist, `age_estimation.liveness`): the block must forbid enumerating.
  assert.match(res.returned_data.semantics, /do NOT enumerate field names/);
});

test("reports the config as unavailable instead of implying the default when unreadable", async () => {
  stubFetch({
    [`${APP_BASE}/verification-settings/`]: {
      results: [{ uuid: "wf-3", workflow_id: "stable-3", workflow_label: "KYC" }],
    },
    [`${APP_BASE}/verification-settings/wf-3/workflow-graph/`]: { graph: GRAPH },
  });
  const res = await inContext("tok-rd-3", () => getWorkflowGraph("stable-3", SCOPE));

  assert.equal(res.returned_data.unavailable, true);
  assert.equal("response_attributes" in res.returned_data, false);
});

test("a settings payload that omits the key reads as unavailable, not as null/ALL", async () => {
  stubFetch({
    [`${APP_BASE}/verification-settings/`]: {
      results: [{ uuid: "wf-5", workflow_id: "stable-5", workflow_label: "KYC" }],
    },
    // The detail responds, but without a response_attributes key — an omission
    // must never be reported as the permissive default.
    [`${APP_BASE}/verification-settings/wf-5/`]: { uuid: "wf-5", status: "published" },
    [`${APP_BASE}/verification-settings/wf-5/workflow-graph/`]: { graph: GRAPH },
  });
  const res = await inContext("tok-rd-5", () => getWorkflowGraph("stable-5", SCOPE));

  assert.equal(res.returned_data.unavailable, true);
});

test("include_config:true still carries returned_data", async () => {
  stubFetch({
    [`${APP_BASE}/verification-settings/wf-4/`]: {
      uuid: "wf-4",
      status: "published",
      response_attributes: { OCR: ["date_of_birth"] },
    },
    [`${APP_BASE}/verification-settings/wf-4/workflow-graph/`]: { graph: GRAPH },
  });
  const res = await inContext("tok-rd-4", () => getWorkflowGraph("wf-4", SCOPE, true));

  assert.deepEqual(res.returned_data.response_attributes, { OCR: ["date_of_birth"] });
  assert.equal(res.config_summarized, undefined);
});
