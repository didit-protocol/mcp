import { test } from "node:test";
import assert from "node:assert/strict";
import { editWorkflowGraph, publishWorkflow } from "../dist/tools/workflow-graph.js";
import { requestContext } from "../dist/config.js";

/**
 * WHICH version a publish actually makes live.
 *
 * Editing a published workflow never mutates the live version: edit_graph
 * auto-creates a draft and applies the change there, returning the draft's
 * `version_uuid`. Publishing afterwards with the STABLE workflow_id resolves
 * back through the list endpoint — which does not surface drafts (see the
 * comment on resolveWorkflowScope) — so it re-publishes the version that was
 * already live and the draft holding every edit stays a draft. Both calls
 * return success, so the caller is told the change is live when it is not.
 *
 * Reported 2026-08-25: a customer was told twice that two KYB workflows were
 * "updated and published" and answered "nothing you did was saved in the live
 * Vendor/Lessor Business Verification".
 *
 * publishWorkflow now follows the draft (create-draft is idempotent, so it
 * returns the one that already holds the edits) and refuses to no-op when there
 * is nothing pending. The last test covers the same class of defect one layer
 * down: the save result used to fall back to the graph the caller SENT, so a
 * field the backend kept was reported as removed.
 */

const API = "https://verification.didit.me/v3";
const APP = `${API}/organization/org-1/application/app-1`;
const SCOPE = { organization_id: "org-1", application_id: "app-1" };
const STABLE = "stable-kyb";
const PUBLISHED = "published-v1";
const DRAFT = "draft-v2";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const calls = [];

/** Route fetches by "METHOD path" (query stripped) so the PATCH that publishes
 * is distinguishable from the PUT that saves the graph; anything unrouted 404s
 * like the backend. Every call is recorded — the assertion is about which
 * version uuid the publish hit. */
const stubFetch = (routes) => {
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).split("?")[0];
    const handler = routes[`${method} ${path}`];

    calls.push({ method, path });
    if (!handler) return json({ detail: "Not found." }, 404);

    return typeof handler === "function" ? handler() : json(handler);
  };
};

const inContext = (token, fn) => requestContext.run({ accessToken: token }, fn);

const patchedVersions = () =>
  calls.filter((call) => call.method === "PATCH").map((call) => call.path);

/** A published KYB flow whose registry step still collects the tax number —
 * the field the customer asked to remove. */
const liveGraph = {
  start_node: "registry",
  nodes: {
    registry: {
      node_type: "feature",
      feature: "KYB_REGISTRY",
      config: {
        kyb_registry_fields_config: {
          tax_number: { enabled: 1, required: 0 },
          company_type: { enabled: 1, required: 0 },
        },
      },
      next: "approved",
    },
    approved: { node_type: "status", session_status: "Approved" },
  },
};

/** Disable the tax number the way the copilot does — a config merge on the
 * registry node. */
const DISABLE_TAX_NUMBER = [
  {
    op: "merge_node_config",
    node_id: "registry",
    config: {
      kyb_registry_fields_config: {
        tax_number: { enabled: 0, required: 0 },
        company_type: { enabled: 1, required: 0 },
      },
    },
  },
];

const ROUTES = {
  // A stable workflow_id is not a settings uuid, so the direct version fetch
  // misses and resolution falls through to the list.
  [`GET ${APP}/verification-settings/${STABLE}/`]: () => json({ detail: "Not found." }, 404),
  // The list endpoint surfaces the published version only — never the draft.
  [`GET ${APP}/verification-settings/`]: {
    results: [
      {
        uuid: PUBLISHED,
        workflow_id: STABLE,
        status: "published",
        // The row says a draft exists — the signal a correct publish can follow
        // to the version that actually holds the edits.
        has_draft: true,
        version: 2,
        workflow_label: "Vendor/Lessor Business Verification (KYB)",
      },
    ],
  },
  [`GET ${APP}/verification-settings/${PUBLISHED}/workflow-graph/`]: { graph: liveGraph },
  [`POST ${APP}/verification-settings/${PUBLISHED}/create-draft/`]: {
    uuid: DRAFT,
    status: "draft",
  },
  [`POST ${APP}/workflow-graph/validate/`]: { is_valid: true },
  [`PUT ${APP}/verification-settings/${DRAFT}/workflow-graph/`]: { graph: liveGraph },
  // The read-back after the save. It still carries tax_number enabled: the save
  // was accepted and the field the caller asked to disable is still collected —
  // the exact drift a result built from the REQUEST can never show.
  [`GET ${APP}/verification-settings/${DRAFT}/workflow-graph/`]: { graph: liveGraph },
  [`PATCH ${APP}/verification-settings/${DRAFT}/`]: { uuid: DRAFT, status: "published" },
  [`PATCH ${APP}/verification-settings/${PUBLISHED}/`]: { uuid: PUBLISHED, status: "published" },
  // The draft's own version uuid IS resolvable directly — the path that works.
  [`GET ${APP}/verification-settings/${DRAFT}/`]: { uuid: DRAFT, status: "draft" },
};

test("a draft-only edit lands on a new version, not the live one", async () => {
  stubFetch(ROUTES);
  const edit = await inContext("tok-edit", () =>
    editWorkflowGraph(STABLE, DISABLE_TAX_NUMBER, false, SCOPE),
  );

  assert.equal(edit.applied, true);
  assert.equal(edit.created_draft, true);
  assert.equal(edit.version_uuid, DRAFT);
  assert.equal(edit.published, false);
  assert.deepEqual(patchedVersions(), [], "a draft-only edit must publish nothing");
});

test("publishing the draft by its own version uuid makes that version live", async () => {
  stubFetch(ROUTES);
  await inContext("tok-uuid", () => publishWorkflow(DRAFT, SCOPE));

  assert.deepEqual(patchedVersions(), [`${APP}/verification-settings/${DRAFT}/`]);
});

test("publishing by stable workflow_id publishes the draft that holds the edits", async () => {
  stubFetch(ROUTES);
  const edit = await inContext("tok-stable", () =>
    editWorkflowGraph(STABLE, DISABLE_TAX_NUMBER, false, SCOPE),
  );

  assert.equal(edit.version_uuid, DRAFT, "the edit went to a fresh draft");
  await inContext("tok-stable", () => publishWorkflow(STABLE, SCOPE));

  assert.deepEqual(patchedVersions(), [`${APP}/verification-settings/${DRAFT}/`]);
});

test("a draft-only edit names the version to publish", async () => {
  stubFetch(ROUTES);
  const edit = await inContext("tok-note", () =>
    editWorkflowGraph(STABLE, DISABLE_TAX_NUMBER, false, SCOPE),
  );

  assert.match(edit.note, new RegExp(DRAFT), "the note must carry the draft's version uuid");
});

test("publishing a live version with nothing pending fails instead of reporting success", async () => {
  stubFetch({
    ...ROUTES,
    [`GET ${APP}/verification-settings/`]: {
      results: [{ uuid: PUBLISHED, workflow_id: STABLE, status: "published", has_draft: false }],
    },
  });
  const err = await inContext("tok-nodraft", () => publishWorkflow(STABLE, SCOPE)).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "expected publishWorkflow to throw");
  assert.match(err.message, /nothing to publish and nothing changed/);
  assert.deepEqual(patchedVersions(), [], "a no-op publish must not touch the live version");
});

test("publishing a published version by its own uuid refuses rather than cloning it", async () => {
  // Resolved by the direct version fetch, whose serializer carries no has_draft. Without a
  // positive signal, following "the draft" would clone the live version and publish the clone —
  // a brand new version that changes nothing.
  stubFetch({
    ...ROUTES,
    [`GET ${APP}/verification-settings/${PUBLISHED}/`]: { uuid: PUBLISHED, status: "published" },
  });
  const err = await inContext("tok-byuuid", () => publishWorkflow(PUBLISHED, SCOPE)).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "expected publishWorkflow to throw");
  assert.match(err.message, /no draft version to publish/);
  assert.deepEqual(patchedVersions(), []);
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith("/create-draft/")),
    [],
    "and it must not create a version as a side effect of a publish",
  );
});

test("the saved graph is re-read, never echoed back from the request", async () => {
  // The backend keeps tax_number enabled — the field the caller asked to
  // disable. The result must show what was STORED, not what was sent.
  stubFetch(ROUTES);
  const edit = await inContext("tok-readback", () =>
    editWorkflowGraph(STABLE, DISABLE_TAX_NUMBER, false, SCOPE),
  );
  const fields = edit.graph.nodes.registry.config.kyb_registry_fields_config;

  assert.equal(edit.graph_read_back, true);
  assert.equal(fields.tax_number.enabled, 1, "the stored graph still collects the tax number");
  assert.deepEqual(edit.unconfirmed_config_keys, ["registry.config.kyb_registry_fields_config"]);
  assert.match(edit.note, /does NOT match what was requested/);
});
