import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkflowScope, searchWorkflows } from "../dist/tools/search.js";
import { requestContext } from "../dist/config.js";

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";
const OLD_UUID = "46868985-8bfb-41a6-ad79-23f5f6757abe";

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

const ONE_ORG_TWO_APPS = {
  [`${AUTH}/organizations/me/`]: [{ uuid: "org-1", name: "Org One" }],
  [`${AUTH}/organizations/me/org-1/applications/`]: [
    { uuid: "app-1", name: "App One" },
    { uuid: "app-2", name: "App Two" },
  ],
  [`${API}/organization/org-1/application/app-1/verification-settings/`]: {
    results: [{ uuid: "current-1", workflow_id: "stable-1", workflow_label: "KYC" }],
  },
  [`${API}/organization/org-1/application/app-2/verification-settings/`]: { results: [] },
};

test("cross-app: resolves a version uuid the list endpoint does not surface (bug repro)", async () => {
  stubFetch({
    ...ONE_ORG_TWO_APPS,
    // The superseded version a session still references — only the direct version endpoint has it.
    [`${API}/organization/org-1/application/app-2/verification-settings/${OLD_UUID}/`]: {
      uuid: OLD_UUID,
      workflow_id: "stable-2",
      status: "published",
    },
  });
  const scope = await inContext("tok-1", () => resolveWorkflowScope(OLD_UUID));

  assert.equal(scope.organizationId, "org-1");
  assert.equal(scope.applicationId, "app-2");
  assert.equal(scope.workflow.uuid, OLD_UUID);
});

test("cross-app: list-based resolution keeps working as before (stable workflow_id)", async () => {
  stubFetch(ONE_ORG_TWO_APPS);
  const scope = await inContext("tok-2", () => resolveWorkflowScope("stable-1"));

  assert.equal(scope.organizationId, "org-1");
  assert.equal(scope.applicationId, "app-1");
  assert.equal(scope.workflow.uuid, "current-1");
});

test("scoped: org+app callers resolve via the direct fetch, no discovery calls", async () => {
  stubFetch({
    [`${API}/organization/org-9/application/app-9/verification-settings/wf-9/`]: {
      uuid: "wf-9",
      status: "draft",
    },
  });
  const scope = await inContext("tok-3", () => resolveWorkflowScope("wf-9", "org-9", "app-9"));

  assert.equal(scope.organizationId, "org-9");
  assert.equal(scope.applicationId, "app-9");
  assert.equal(scope.workflow.uuid, "wf-9");
});

test("didit_workflow_search: finds a hidden version uuid via the direct probe", async () => {
  stubFetch({
    ...ONE_ORG_TWO_APPS,
    [`${API}/organization/org-1/application/app-2/verification-settings/${OLD_UUID}/`]: {
      uuid: OLD_UUID,
      workflow_id: "stable-2",
      status: "published",
    },
  });
  const res = await inContext("tok-5", () => searchWorkflows({ workflow_id: OLD_UUID }));

  assert.equal(res.total_matched, 1);
  assert.equal(res.results[0].uuid, OLD_UUID);
  assert.equal(res.results[0].application_id, "app-2");
  assert.equal(res.unlistable_orgs, 0);
});

test("not-found error discloses apps/orgs that could not be scanned", async () => {
  stubFetch({
    [`${AUTH}/organizations/me/`]: [
      { uuid: "org-1", name: "Org One" },
      { uuid: "org-2", name: "Org Two" },
    ],
    [`${AUTH}/organizations/me/org-1/applications/`]: [{ uuid: "app-1", name: "App One" }],
    [`${AUTH}/organizations/me/org-2/applications/`]: () => json({ detail: "Forbidden." }, 403),
    [`${API}/organization/org-1/application/app-1/verification-settings/`]: () =>
      json({ detail: "Server error." }, 500),
  });
  const err = await inContext("tok-4", () => resolveWorkflowScope("missing-wf")).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "expected resolveWorkflowScope to throw");
  assert.match(err.message, /was not found in any of your applications/);
  assert.match(err.message, /1 application\(s\) returned errors/);
  assert.match(err.message, /1 organization\(s\) could not be listed/);
});
