// A workflow setting the API does not know is dropped without an error.
//
// The API validates a node's `config` through the feature's serializer and keeps what the
// serializer knows. A key it does not know is not refused: it is left out, the save succeeds,
// and nothing says so. Reproduced on staging on 12 November 2026: asked to create and publish
// "ID verification and AML, review at 80 and decline at 95" with the made-up key
// `aml_score_decline_threshold`, the server answered "Workflow created and published - live
// for new sessions". The workflow was live, and it declined nobody at 95.
//
// The API does say what it kept: the validation answer and the stored graph both carry the
// config as it was accepted. These tests hold the four tools that send settings to comparing
// what they sent with what came back, to saying which settings were lost, and to never
// publishing a workflow that lost one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { createWorkflow } from "../dist/tools/settings.js";
import { editWorkflowGraph, setWorkflowGraph, validateWorkflowGraph } from "../dist/tools/workflow-graph.js";
import { lostSettings } from "../dist/tools/feature-config.js";

const API = "https://verification.didit.me/v3";
const APP = `${API}/organization/org-1/application/app-1`;
const SCOPE = { organization_id: "org-1", application_id: "app-1" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const inContext = (fn) =>
  requestContext.run({ accessToken: `tok-dropped-${Math.random()}`, organizationId: "org-1", applicationId: "app-1" }, fn);

/** What the API's serializers know, for this test: every other key of a config is left out. */
const KNOWN = new Set(["aml_score_review_threshold", "aml_score_approve_threshold", "documents_allowed"]);
const asAccepted = (graph) => ({
  ...graph,
  nodes: Object.fromEntries(
    Object.entries(graph.nodes ?? {}).map(([id, node]) => [
      id,
      node.config ? { ...node, config: Object.fromEntries(Object.entries(node.config).filter(([key]) => KNOWN.has(key))) } : node,
    ]),
  ),
});

/** A backend that behaves like the real one: valid, saved, and silent about what it left out. */
function fakeBackend({ stored = null, validationGraph = true, readable = true, readableTimes = Infinity } = {}) {
  const state = { calls: [], stored };
  let reads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push(`${method} ${path.replace(APP, "")}`);
    if (path === `${APP}/verification-settings/` && method === "POST") return json({ uuid: "wf-new", status: "draft", workflow_url: "https://verify.didit.me/u/x" });
    if (path === `${APP}/workflow-graph/validate/`) return json({ is_valid: true, ...(validationGraph ? { graph: asAccepted(body.graph) } : {}), warnings: [] });
    if (path.endsWith("/workflow-graph/") && method === "PUT") {
      state.stored = asAccepted(body.graph);
      return json({ graph: state.stored });
    }
    if (path.endsWith("/workflow-graph/") && method === "GET") {
      const canRead = readable && reads++ < readableTimes;
      return canRead && state.stored ? json({ graph: state.stored }) : json({ detail: "Service unavailable." }, canRead ? 404 : 503);
    }
    if (path === `${APP}/verification-settings/wf-new/` && method === "GET") return json({ uuid: "wf-new", status: "draft" });
    if (path === `${APP}/verification-settings/wf-new/` && method === "PATCH") return json({ uuid: "wf-new", status: body.status });
    return json({ detail: "Not found." }, 404);
  };
  return state;
}

const published = (state) => state.calls.filter((call) => call.startsWith("PATCH"));

const AML_WITH_MADE_UP_KEY = { feature: "AML", config: { aml_score_review_threshold: 80, aml_score_decline_threshold: 95 } };
const GRAPH = {
  start_node: "ocr",
  nodes: {
    ocr: { node_type: "feature", feature: "OCR", next: "aml" },
    aml: { node_type: "feature", ...AML_WITH_MADE_UP_KEY, next: "done" },
    done: { node_type: "status", session_status: "Determine" },
  },
};

test("a created workflow that lost a setting is not published, and the answer names the setting", async () => {
  const state = fakeBackend();
  const result = await inContext(() => createWorkflow({ workflow_label: "AML strict", features: [{ feature: "OCR" }, AML_WITH_MADE_UP_KEY] }));

  assert.equal(result.created, true);
  assert.equal(result.graph_applied, true, "the settings the API knows are saved");
  assert.equal(result.status, "draft", "asked to publish, and held back");
  assert.deepEqual(published(state), [], "nothing went live");
  assert.equal(result.dropped_config_keys.length, 1);
  assert.match(result.dropped_config_keys[0], /\.config\.aml_score_decline_threshold$/);
  assert.match(result.note, /NOT published/);
  assert.match(result.note, /1 setting was NOT saved: \S+\.config\.aml_score_decline_threshold\./);
  assert.match(result.note, /didit_workflow_get_feature_config_schema/);
  assert.match(result.note, /AML/);
  // The model is told what to do when no key does what was asked, instead of publishing without it.
  assert.match(result.note, /cannot be configured/);
});

test("a created workflow whose settings were all kept is published as before", async () => {
  const state = fakeBackend();
  const result = await inContext(() =>
    createWorkflow({ workflow_label: "AML", features: [{ feature: "OCR" }, { feature: "AML", config: { aml_score_review_threshold: 80 } }] }),
  );

  assert.equal(result.status, "published");
  assert.equal(published(state).length, 1);
  assert.equal(result.dropped_config_keys, undefined);
  assert.match(result.note, /created and published/);
});

test("a draft that lost a setting says so too", async () => {
  fakeBackend();
  const result = await inContext(() => createWorkflow({ workflow_label: "AML", status: "draft", features: [{ feature: "OCR" }, AML_WITH_MADE_UP_KEY] }));

  assert.equal(result.status, "draft");
  assert.equal(result.dropped_config_keys.length, 1);
  assert.match(result.note, /aml_score_decline_threshold/);
});

test("a full replace reports the lost setting and does not publish", async () => {
  const state = fakeBackend();
  const result = await inContext(() => setWorkflowGraph("wf-new", structuredClone(GRAPH), true, SCOPE));

  assert.deepEqual(result.dropped_config_keys, ["aml.config.aml_score_decline_threshold"]);
  assert.equal(result.published, false);
  assert.equal(result.status, "draft");
  assert.deepEqual(published(state), []);
  assert.match(result.note, /NOT published/);
  assert.match(result.note, /aml\.config\.aml_score_decline_threshold/);
  assert.match(result.note, /with the feature \(AML\)/);
  // The stored graph is what is shown, and it does not carry the key.
  assert.equal("aml_score_decline_threshold" in result.graph.nodes.aml.config, false);
});

test("a full replace with nothing lost publishes as before", async () => {
  const state = fakeBackend();
  const graph = structuredClone(GRAPH);
  delete graph.nodes.aml.config.aml_score_decline_threshold;
  const result = await inContext(() => setWorkflowGraph("wf-new", graph, true, SCOPE));

  assert.equal(result.published, true);
  assert.equal(result.dropped_config_keys, undefined);
  assert.equal(published(state).length, 1);
});

test("a small edit reports a made-up setting as lost, apart from one whose value only differs", async () => {
  const kept = structuredClone(GRAPH);
  delete kept.nodes.aml.config.aml_score_decline_threshold;
  const state = fakeBackend({ stored: kept });
  const result = await inContext(() =>
    editWorkflowGraph("wf-new", [{ op: "merge_node_config", node_id: "aml", config: { aml_made_up_setting: true, aml_score_approve_threshold: 60 } }], true, SCOPE),
  );

  assert.equal(result.applied, true);
  assert.deepEqual(result.dropped_config_keys, ["aml.config.aml_made_up_setting"]);
  // The key the API knows was stored as sent, so it is neither lost nor unconfirmed.
  assert.equal(result.unconfirmed_config_keys, undefined);
  assert.equal(result.graph.nodes.aml.config.aml_score_approve_threshold, 60);
  assert.equal(result.published, false);
  assert.deepEqual(published(state), []);
  assert.match(result.note, /NOT published/);
});

test("the dry run says which settings would be lost, before anything is saved", async () => {
  const state = fakeBackend();
  const result = await inContext(() => validateWorkflowGraph(undefined, structuredClone(GRAPH), SCOPE, true));

  assert.equal(result.is_valid, true, "the API's own verdict is passed on as it is");
  assert.deepEqual(result.dropped_config_keys, ["aml.config.aml_score_decline_threshold"]);
  assert.match(result.note, /would NOT be saved/);
  assert.ok(!state.calls.some((call) => call.startsWith("PUT")), "a dry run saves nothing");

  const clean = structuredClone(GRAPH);
  delete clean.nodes.aml.config.aml_score_decline_threshold;
  const fine = await inContext(() => validateWorkflowGraph(undefined, clean, SCOPE, true));
  assert.equal(fine.dropped_config_keys, undefined);
});

// What was stored is the only evidence. When it cannot be read, nothing was compared, and a version
// with settings in it is not put live on the strength of a check that did not happen.

test("when the validation answer carries no graph, the stored one is read, and a loss is still caught", async () => {
  const state = fakeBackend({ validationGraph: false });
  const result = await inContext(() => createWorkflow({ workflow_label: "AML strict", features: [{ feature: "OCR" }, AML_WITH_MADE_UP_KEY] }));

  assert.equal(result.status, "draft");
  assert.equal(result.dropped_config_keys.length, 1);
  assert.deepEqual(published(state), []);

  // The same route with nothing lost publishes: the fallback is a check, not a refusal.
  const clean = fakeBackend({ validationGraph: false });
  const fine = await inContext(() =>
    createWorkflow({ workflow_label: "AML", features: [{ feature: "OCR" }, { feature: "AML", config: { aml_score_review_threshold: 80 } }] }),
  );
  assert.equal(fine.status, "published");
  assert.equal(published(clean).length, 1);
});

test("a created workflow whose settings cannot be checked at all is not published", async () => {
  const state = fakeBackend({ validationGraph: false, readable: false });
  const result = await inContext(() =>
    createWorkflow({ workflow_label: "AML", features: [{ feature: "OCR" }, { feature: "AML", config: { aml_score_review_threshold: 80 } }] }),
  );

  assert.equal(result.status, "draft");
  assert.equal(result.settings_verified, false);
  assert.deepEqual(published(state), []);
  assert.match(result.note, /NOT published, because what the API stored could not be checked/);
  assert.match(result.note, /didit_workflow_get_graph/);
  assert.equal(result.dropped_config_keys, undefined, "nothing is claimed about a comparison that was not made");

  // No settings were sent, so there is nothing a save could lose: published as before, with no extra read.
  const plain = fakeBackend({ validationGraph: false, readable: false });
  const simple = await inContext(() => createWorkflow({ workflow_label: "KYC", features: [{ feature: "OCR" }, { feature: "LIVENESS" }] }));
  assert.equal(simple.status, "published");
  assert.ok(!plain.calls.some((call) => call.startsWith("GET") && call.endsWith("/workflow-graph/")));
});

test("a full replace or an edit that cannot be read back is not published when it carried settings", async () => {
  const replaced = fakeBackend({ readable: false });
  const set = await inContext(() => setWorkflowGraph("wf-new", structuredClone(GRAPH), true, SCOPE));
  assert.equal(set.published, false);
  assert.equal(set.settings_verified, false);
  assert.equal(set.graph_read_back, false);
  assert.deepEqual(published(replaced), []);
  assert.match(set.note, /NOT published, because what the API stored could not be checked/);

  // An edit reads the graph first (that read works here) and cannot read it back after the save.
  const kept = structuredClone(GRAPH);
  delete kept.nodes.aml.config.aml_score_decline_threshold;
  const edited = fakeBackend({ stored: structuredClone(kept), readableTimes: 1 });
  const edit = await inContext(() =>
    editWorkflowGraph("wf-new", [{ op: "merge_node_config", node_id: "aml", config: { aml_score_approve_threshold: 60 } }], true, SCOPE),
  );
  assert.equal(edit.applied, true);
  assert.equal(edit.published, false);
  assert.equal(edit.settings_verified, false);
  assert.deepEqual(published(edited), []);
  // An edit that carries no setting is not held back by a failed read: there was nothing to compare.
  const rewired = fakeBackend({ stored: structuredClone(kept), readableTimes: 1 });
  const rewire = await inContext(() => editWorkflowGraph("wf-new", [{ op: "set_next", node_id: "ocr", next: "aml" }], true, SCOPE));
  assert.equal(rewire.published, true, rewire.note);
  assert.equal(published(rewired).length, 1);

  // A graph with no settings in it has nothing to verify: the publish that was asked for happens.
  const bare = fakeBackend({ readable: false });
  const noSettings = { start_node: "ocr", nodes: { ocr: { node_type: "feature", feature: "OCR", next: "done" }, done: { node_type: "status", session_status: "Determine" } } };
  const plain = await inContext(() => setWorkflowGraph("wf-new", noSettings, true, SCOPE));
  assert.equal(plain.published, true);
  assert.equal(published(bare).length, 1);
});

test("what counts as lost: sent, not returned, and not a key the contract knows", () => {
  const sent = {
    nodes: {
      a: { feature: "AML", config: { aml_score_review_threshold: 80, made_up: 1, cleared: null, aml_score_approve_threshold: 60 } },
      b: { feature: "OCR", config: { documents_allowed: { ESP: { P: { enabled: 1 } } } } },
      gone: { feature: "AML", config: { made_up: 1 } },
      plain: { node_type: "status" },
    },
  };
  const returned = {
    nodes: {
      // The approve threshold is a key the contract knows and the API did not return: not proof of a
      // loss (the API may hold it elsewhere), so it is reported as unconfirmed, never as dropped.
      a: { feature: "AML", config: { aml_score_review_threshold: 75 } },
      b: { feature: "OCR", config: { documents_allowed: { ESP: { P: { enabled: 1 } } } } },
      plain: { node_type: "status" },
    },
  };
  const lost = lostSettings(sent, returned);

  assert.deepEqual(lost.dropped, ["a.config.made_up"]);
  assert.deepEqual(lost.unconfirmed, ["a.config.aml_score_approve_threshold"]);
  assert.deepEqual(lost.features, ["AML"]);
  // A value the API changed is a stored setting. A key sent as null asks for nothing.
  // A node the API did not return at all cannot be compared, and is not guessed about.
  assert.deepEqual(lostSettings(sent, undefined), { dropped: [], unconfirmed: [], features: [] });
  assert.deepEqual(lostSettings(undefined, returned), { dropped: [], unconfirmed: [], features: [] });
});
