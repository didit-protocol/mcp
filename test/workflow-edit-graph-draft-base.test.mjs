import { test } from "node:test";
import assert from "node:assert/strict";
import { editWorkflowGraph } from "../dist/tools/workflow-graph.js";
import { requestContext } from "../dist/config.js";

/**
 * WHICH graph an edit builds on, and what a config merge keeps.
 *
 * Prod 14-nov (thread 2be5e0f4): consecutive didit_workflow_edit_graph calls on
 * a published workflow, each passing the STABLE workflow_id. Every call answered
 * applied:true with the same draft, and every read-back was the PUBLISHED graph
 * plus only that call's ops: the edit read the published version, then saved
 * over the draft (create-draft is idempotent and hands back the existing one),
 * so each call reverted the one before (age 21 and expiry REVIEW flip-flopped
 * three times). In the same calls a merge of `age_restrictions_by_country:
 * {GBR: 21}` replaced the whole 237-country table with GBR alone.
 */

const API = "https://verification.didit.me/v3";
const APP = `${API}/organization/org-1/application/app-1`;
const SCOPE = { organization_id: "org-1", application_id: "app-1" };
const STABLE = "stable-kyc";
const PUBLISHED = "published-v2";
const DRAFT = "draft-v3";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const graphWith = (config) => ({
  start_node: "ocr",
  nodes: {
    ocr: { node_type: "feature", feature: "OCR", config, next: "approved" },
    approved: { node_type: "status", session_status: "Approved" },
  },
});

/** A published version and its draft, stored like the backend stores them: a
 * PUT replaces the version's graph and the next GET reads it back. Every call
 * is recorded with its body. */
const stubBackend = ({ published, draft, overrides = {} }) => {
  const stored = { [PUBLISHED]: published, [DRAFT]: draft };
  const calls = [];
  const routes = {
    // The stable id is not a settings uuid: resolution falls through to the list,
    // which shows the published version only.
    [`GET ${APP}/verification-settings/${STABLE}/`]: () => json({ detail: "Not found." }, 404),
    [`GET ${APP}/verification-settings/`]: () =>
      json({ results: [{ uuid: PUBLISHED, workflow_id: STABLE, status: "published", has_draft: true, version: 2 }] }),
    [`GET ${APP}/verification-settings/${DRAFT}/`]: () => json({ uuid: DRAFT, workflow_id: STABLE, status: "draft", version: 3 }),
    // Idempotent: hands back the draft that already exists.
    [`POST ${APP}/verification-settings/${PUBLISHED}/create-draft/`]: () => json({ uuid: DRAFT, status: "draft" }),
    [`POST ${APP}/workflow-graph/validate/`]: () => json({ is_valid: true }),
    [`GET ${APP}/verification-settings/${PUBLISHED}/workflow-graph/`]: () => json({ graph: stored[PUBLISHED] }),
    [`GET ${APP}/verification-settings/${DRAFT}/workflow-graph/`]: () => json({ graph: stored[DRAFT] }),
    [`PUT ${APP}/verification-settings/${DRAFT}/workflow-graph/`]: (body) => {
      stored[DRAFT] = body.graph;

      return json({ graph: body.graph });
    },
    [`PATCH ${APP}/verification-settings/${DRAFT}/`]: () => json({ uuid: DRAFT, status: "published" }),
    ...overrides,
  };

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).split("?")[0];
    const body = init.body ? JSON.parse(init.body) : undefined;
    const handler = routes[`${method} ${path}`];

    calls.push({ method, path, body });
    if (!handler) return json({ detail: "Not found." }, 404);

    return handler(body);
  };

  return { calls, stored };
};

const inContext = (token, fn) => requestContext.run({ accessToken: token }, fn);

const graphReads = (calls) =>
  calls.filter((call) => call.method === "GET" && call.path.endsWith("/workflow-graph/")).map((call) => call.path);

const puts = (calls) => calls.filter((call) => call.method === "PUT");

const merge = (config, extra = {}) => [{ op: "merge_node_config", node_id: "ocr", config, ...extra }];

test("an edit through the stable id builds on the existing draft, not the published version", async () => {
  const { calls } = stubBackend({ published: graphWith({ a: 1 }), draft: graphWith({ a: 1, b: 2 }) });
  const edit = await inContext("tok-base", () => editWorkflowGraph(STABLE, merge({ c: 3 }), false, SCOPE));

  assert.equal(edit.applied, true);
  assert.equal(edit.version_uuid, DRAFT);
  assert.equal(graphReads(calls)[0], `${APP}/verification-settings/${DRAFT}/workflow-graph/`, "the base graph is the draft's");
  assert.ok(
    !graphReads(calls).includes(`${APP}/verification-settings/${PUBLISHED}/workflow-graph/`),
    "the published graph is never the base of an edit",
  );
  assert.equal(puts(calls).length, 1);
  assert.equal(puts(calls)[0].path, `${APP}/verification-settings/${DRAFT}/workflow-graph/`);
  assert.deepEqual(puts(calls)[0].body.graph.nodes.ocr.config, { a: 1, b: 2, c: 3 });
});

test("consecutive edits through the stable id accumulate on the draft", async () => {
  const { stored } = stubBackend({ published: graphWith({ age: 18, expiry: "DECLINE" }), draft: graphWith({ age: 18, expiry: "DECLINE" }) });
  await inContext("tok-twice", () => editWorkflowGraph(STABLE, merge({ age: 21 }), false, SCOPE));
  await inContext("tok-twice", () => editWorkflowGraph(STABLE, merge({ expiry: "REVIEW" }), false, SCOPE));

  assert.deepEqual(stored[DRAFT].nodes.ocr.config, { age: 21, expiry: "REVIEW" }, "the second edit kept the first");
  assert.deepEqual(stored[PUBLISHED].nodes.ocr.config, { age: 18, expiry: "DECLINE" }, "the published version is untouched");
});

test("merge_node_config merges a map-valued key by entry and keeps the entries not sent", async () => {
  const byCountry = { GBR: 18, ESP: 18, FRA: 18 };
  const { calls } = stubBackend({ published: graphWith({ byCountry }), draft: graphWith({ byCountry }) });
  const edit = await inContext("tok-map", () => editWorkflowGraph(STABLE, merge({ byCountry: { GBR: 21 } }), false, SCOPE));

  assert.deepEqual(puts(calls)[0].body.graph.nodes.ocr.config.byCountry, { GBR: 21, ESP: 18, FRA: 18 });
  assert.equal(edit.unconfirmed_config_keys, undefined, "the stored map holds what was asked for");
});

test("a map entry the API dropped on save is reported, not taken as kept", async () => {
  const byCountry = { GBR: 18, ESP: 18 };
  const { stored } = stubBackend({
    published: graphWith({ byCountry }),
    draft: graphWith({ byCountry }),
    overrides: {
      // The save keeps only the entry that was sent: ESP is gone.
      [`PUT ${APP}/verification-settings/${DRAFT}/workflow-graph/`]: (body) => {
        stored[DRAFT] = graphWith({ byCountry: { GBR: 21 } });

        return json({ graph: body.graph });
      },
    },
  });
  const edit = await inContext("tok-dropped", () => editWorkflowGraph(STABLE, merge({ byCountry: { GBR: 21 } }), false, SCOPE));

  assert.deepEqual(edit.unconfirmed_config_keys, ["ocr.config.byCountry"]);
});

test("merge_node_config still replaces arrays and scalars, and replaces a map when asked to", async () => {
  const config = { byCountry: { GBR: 18, ESP: 18 }, list: ["A", "B"], flag: true };
  const { calls } = stubBackend({ published: graphWith(config), draft: graphWith(config) });
  await inContext("tok-replace", () =>
    editWorkflowGraph(STABLE, merge({ list: ["C"], flag: false }), false, SCOPE),
  );
  await inContext("tok-replace", () =>
    editWorkflowGraph(STABLE, merge({ byCountry: { ESP: 21 } }, { replace: true }), false, SCOPE),
  );

  assert.deepEqual(puts(calls)[0].body.graph.nodes.ocr.config, { byCountry: { GBR: 18, ESP: 18 }, list: ["C"], flag: false });
  assert.deepEqual(puts(calls)[1].body.graph.nodes.ocr.config.byCountry, { ESP: 21 });
});

test("an edit of a draft passed by its own version uuid creates nothing and edits that draft", async () => {
  const { calls } = stubBackend({ published: graphWith({ a: 1 }), draft: graphWith({ a: 1, b: 2 }) });
  const edit = await inContext("tok-draft", () => editWorkflowGraph(DRAFT, merge({ c: 3 }), false, SCOPE));

  assert.equal(edit.created_draft, false);
  assert.equal(edit.version_uuid, DRAFT);
  assert.deepEqual(calls.filter((call) => call.path.endsWith("/create-draft/")), []);
  assert.deepEqual(puts(calls)[0].body.graph.nodes.ocr.config, { a: 1, b: 2, c: 3 });
});

test("a failed create-draft saves nothing", async () => {
  const { calls } = stubBackend({
    published: graphWith({ a: 1 }),
    draft: graphWith({ a: 1 }),
    overrides: {
      [`POST ${APP}/verification-settings/${PUBLISHED}/create-draft/`]: () => json({ detail: "Server error." }, 500),
    },
  });
  const err = await inContext("tok-nodraft", () => editWorkflowGraph(STABLE, merge({ c: 3 }), false, SCOPE)).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "expected the edit to fail");
  assert.deepEqual(puts(calls), []);
});

test("a graph that fails validation is not saved", async () => {
  const { calls } = stubBackend({
    published: graphWith({ a: 1 }),
    draft: graphWith({ a: 1 }),
    overrides: { [`POST ${APP}/workflow-graph/validate/`]: () => json({ is_valid: false, errors: ["bad"] }) },
  });
  const edit = await inContext("tok-invalid", () => editWorkflowGraph(STABLE, merge({ c: 3 }), false, SCOPE));

  assert.equal(edit.applied, false);
  assert.deepEqual(puts(calls), []);
});

test("publish:true publishes the draft the edit was saved to", async () => {
  const { calls } = stubBackend({ published: graphWith({ a: 1 }), draft: graphWith({ a: 1, b: 2 }) });
  const edit = await inContext("tok-publish", () => editWorkflowGraph(STABLE, merge({ c: 3 }), true, SCOPE));

  assert.equal(edit.published, true);
  assert.deepEqual(
    calls.filter((call) => call.method === "PATCH").map((call) => call.path),
    [`${APP}/verification-settings/${DRAFT}/`],
  );
});
