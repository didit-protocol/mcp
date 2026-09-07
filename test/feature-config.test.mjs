import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDocumentsAllowed,
  normalizeLanguagesAllowed,
  normalizeFeatureConfig,
  normalizeFeatureConfigs,
  buildLinearGraphFromFeatures,
  resolveBranchRuleNodeIds,
  assertKycKybSegregation,
} from "../dist/tools/feature-config.js";

// Regression guard for the workflow-creation failure mode: a user asked the MCP to build an
// "ID verification, passport only" workflow and the agent burned many attempts because every
// natural documents_allowed shape it tried was rejected by the backend with the opaque
// "At least one document type must be allowed for a country." These are those exact inputs.

const PASSPORT_ONLY = JSON.stringify({ P: { enabled: 1 } });
const isAllCountriesPassportOnly = (out) => {
  const keys = Object.keys(out);
  return (
    keys.length === 237 &&
    keys.every((k) => JSON.stringify(out[k]) === PASSPORT_ONLY) &&
    out.USA && out.ESP && out.ABW && out.ZWE
  );
};

test("documents_allowed: flat array ['PASSPORT'] -> passport-only for every country", () => {
  assert.ok(isAllCountriesPassportOnly(normalizeDocumentsAllowed(["PASSPORT"])));
});

test("documents_allowed: the four 'ALL' pseudo-country shapes the agent tried all normalize", () => {
  assert.ok(isAllCountriesPassportOnly(normalizeDocumentsAllowed({ ALL: { PASSPORT: true } })));
  assert.ok(isAllCountriesPassportOnly(normalizeDocumentsAllowed({ ALL: { P: true } })));
  assert.ok(isAllCountriesPassportOnly(normalizeDocumentsAllowed({ ALL: { PASSPORT: 1 } })));
  assert.ok(isAllCountriesPassportOnly(normalizeDocumentsAllowed({ "*": { P: 1 } })));
});

test("documents_allowed: per-country scalar/name shapes -> canonical objects", () => {
  assert.deepEqual(normalizeDocumentsAllowed({ ESP: { P: 1 } }), { ESP: { P: { enabled: 1 } } });
  assert.deepEqual(normalizeDocumentsAllowed({ ESP: { PASSPORT: true } }), { ESP: { P: { enabled: 1 } } });
  assert.deepEqual(
    normalizeDocumentsAllowed({ USA: { NATIONAL_ID: 1, DRIVER_LICENSE: 1, RESIDENCE_PERMIT: 1 } }),
    { USA: { ID: { enabled: 1 }, DL: { enabled: 1 }, RP: { enabled: 1 } } },
  );
});

test("documents_allowed: already-canonical is unchanged (idempotent) and preserves extra keys", () => {
  const canonical = { ESP: { P: { enabled: 1 } } };
  assert.deepEqual(normalizeDocumentsAllowed(canonical), canonical);
  assert.deepEqual(
    normalizeDocumentsAllowed({ ESP: { P: { enabled: 1, sides: 2 } } }),
    { ESP: { P: { enabled: 1, sides: 2 } } },
  );
  // disabled flags are honoured, not forced on
  assert.deepEqual(normalizeDocumentsAllowed({ ESP: { P: false } }), { ESP: { P: { enabled: 0 } } });
});

test("documents_allowed: null/empty are safe no-ops", () => {
  assert.equal(normalizeDocumentsAllowed(null), null);
  assert.equal(normalizeDocumentsAllowed(undefined), undefined);
  assert.deepEqual(normalizeDocumentsAllowed({}), {});
});

test("poa_languages_allowed: array and map shapes -> { lang: 0|1 }", () => {
  assert.deepEqual(normalizeLanguagesAllowed(["es"]), { es: 1 });
  assert.deepEqual(normalizeLanguagesAllowed(["ES", "EN"]), { es: 1, en: 1 });
  assert.deepEqual(normalizeLanguagesAllowed({ es: 1 }), { es: 1 });
  assert.deepEqual(normalizeLanguagesAllowed({ es: true, fr: false }), { es: 1, fr: 0 });
});

test("normalizeFeatureConfig: rewrites a single feature config in place", () => {
  const cfg = { documents_allowed: { ESP: { PASSPORT: 1 } }, poa_languages_allowed: ["es"] };
  normalizeFeatureConfig(cfg);
  assert.deepEqual(cfg.documents_allowed, { ESP: { P: { enabled: 1 } } });
  assert.deepEqual(cfg.poa_languages_allowed, { es: 1 });
});

test("normalizeFeatureConfigs: walks a whole graph (the user's intended workflow)", () => {
  const graph = {
    start_node: "ocr",
    nodes: {
      ocr: { node_type: "feature", feature: "OCR", config: { documents_allowed: ["PASSPORT"] }, next: "poa" },
      poa: { node_type: "feature", feature: "PROOF_OF_ADDRESS", config: { poa_languages_allowed: ["es"] }, next: "s" },
      s: { node_type: "status", session_status: "Determine" },
    },
  };
  normalizeFeatureConfigs(graph);
  assert.ok(isAllCountriesPassportOnly(graph.nodes.ocr.config.documents_allowed));
  assert.deepEqual(graph.nodes.poa.config.poa_languages_allowed, { es: 1 });
  // non-feature / config-less nodes are untouched
  assert.deepEqual(graph.nodes.s, { node_type: "status", session_status: "Determine" });
});

// buildLinearGraphFromFeatures — the create path: the console drops a `features` payload, so the
// MCP must turn the requested features into a real graph that actually runs them.

test("buildLinearGraphFromFeatures: chains features into an auto-decide status", () => {
  const g = buildLinearGraphFromFeatures([
    { feature: "OCR" },
    { feature: "LIVENESS", config: { face_liveness_method: "PASSIVE" } },
    { feature: "FACE_MATCH", label: "Selfie match" },
  ]);
  assert.equal(g.start_node, "ocr");
  assert.equal(g.nodes.ocr.next, "liveness");
  assert.equal(g.nodes.liveness.next, "face_match");
  assert.deepEqual(g.nodes.liveness.config, { face_liveness_method: "PASSIVE" });
  assert.equal(g.nodes.face_match.label, "Selfie match");
  assert.equal(g.nodes.face_match.next, "final_status");
  assert.deepEqual(g.nodes.final_status, { node_type: "status", session_status: "Determine" });
  // every feature node is typed
  for (const id of ["ocr", "liveness", "face_match"]) assert.equal(g.nodes[id].node_type, "feature");
});

test("buildLinearGraphFromFeatures: single feature still terminates in a status", () => {
  const g = buildLinearGraphFromFeatures([{ feature: "OCR" }]);
  assert.equal(g.start_node, "ocr");
  assert.equal(g.nodes.ocr.next, "final_status");
  assert.equal(g.nodes.final_status.session_status, "Determine");
});

test("buildLinearGraphFromFeatures: duplicate feature names get unique ids", () => {
  const g = buildLinearGraphFromFeatures([{ feature: "OCR" }, { feature: "OCR" }]);
  assert.equal(g.start_node, "ocr");
  assert.equal(g.nodes.ocr.next, "ocr_2");
  assert.equal(g.nodes.ocr_2.next, "final_status");
});

test("buildLinearGraphFromFeatures: refuses to build a featureless workflow", () => {
  assert.throws(() => buildLinearGraphFromFeatures([]), /no features/i);
  assert.throws(() => buildLinearGraphFromFeatures([{ config: {} }]), /no features/i);
});

// resolveBranchRuleNodeIds — a branch rule must carry node_id pointing to the feature node that
// produces its field, or the runtime silently branches on the wrong (first) instance.

test("resolveBranchRuleNodeIds: the reported case — kyc rule gets the OCR node's id", () => {
  const graph = {
    start_node: "ocr_dl_es",
    nodes: {
      ocr_dl_es: { node_type: "feature", feature: "OCR", next: "decide" },
      decide: {
        node_type: "branch",
        branches: [
          { id: "is_software_engineer", goto: "liveness", logic: "and", rules: [
            { field: "kyc.extra_fields.profession", operator: "fuzzy_match", value: "Software Engineer", score: 70 },
          ] },
          { id: "else", goto: "poa", logic: "and", rules: [] },
        ],
      },
      liveness: { node_type: "feature", feature: "LIVENESS", next: "s" },
      poa: { node_type: "feature", feature: "PROOF_OF_ADDRESS", next: "s" },
      s: { node_type: "status", session_status: "Determine" },
    },
  };
  resolveBranchRuleNodeIds(graph);
  assert.equal(graph.nodes.decide.branches[0].rules[0].node_id, "ocr_dl_es");
  // else branch (empty rules) untouched
  assert.deepEqual(graph.nodes.decide.branches[1].rules, []);
});

test("resolveBranchRuleNodeIds: maps each prefix to the right feature node", () => {
  const graph = {
    start_node: "ocr",
    nodes: {
      ocr: { node_type: "feature", feature: "OCR", next: "aml" },
      aml: { node_type: "feature", feature: "AML", next: "br" },
      br: { node_type: "branch", branches: [
        { id: "a", goto: "s", rules: [
          { field: "kyc.status", operator: "equals", value: "Approved" },
          { field: "aml.status", operator: "equals", value: "Clear" },
        ] },
        { id: "else", goto: "s", rules: [] },
      ] },
      s: { node_type: "status", session_status: "Determine" },
    },
  };
  resolveBranchRuleNodeIds(graph);
  const rules = graph.nodes.br.branches[0].rules;
  assert.equal(rules[0].node_id, "ocr");
  assert.equal(rules[1].node_id, "aml");
});

test("resolveBranchRuleNodeIds: multiple nodes of a feature -> the upstream one nearest the branch", () => {
  const graph = {
    start_node: "ocr_1",
    nodes: {
      ocr_1: { node_type: "feature", feature: "OCR", next: "ocr_2" },
      ocr_2: { node_type: "feature", feature: "OCR", next: "br" },
      br: { node_type: "branch", branches: [
        { id: "a", goto: "s", rules: [{ field: "kyc.status", operator: "equals", value: "Approved" }] },
        { id: "else", goto: "s", rules: [] },
      ] },
      s: { node_type: "status", session_status: "Determine" },
    },
  };
  resolveBranchRuleNodeIds(graph);
  // ocr_2 is the most recent OCR upstream of the branch
  assert.equal(graph.nodes.br.branches[0].rules[0].node_id, "ocr_2");
});

test("resolveBranchRuleNodeIds: leaves explicit node_id, field@node_id, and non-feature fields alone", () => {
  const graph = {
    start_node: "ocr",
    nodes: {
      ocr: { node_type: "feature", feature: "OCR", next: "br" },
      br: { node_type: "branch", branches: [
        { id: "explicit", goto: "s", rules: [{ field: "kyc.age", operator: "greater_than", value: 18, node_id: "kept" }] },
        { id: "atsyntax", goto: "s", rules: [{ field: "kyc.age@ocr", operator: "greater_than", value: 18 }] },
        { id: "session", goto: "s", rules: [{ field: "session.vendor_data", operator: "is_not_empty" }] },
        { id: "else", goto: "s", rules: [] },
      ] },
      s: { node_type: "status", session_status: "Determine" },
    },
  };
  resolveBranchRuleNodeIds(graph);
  const [explicit, atsyntax, session] = graph.nodes.br.branches;
  assert.equal(explicit.rules[0].node_id, "kept");            // explicit preserved
  assert.equal(atsyntax.rules[0].node_id, undefined);         // @-syntax handled backend-side
  assert.equal(session.rules[0].node_id, undefined);          // session is not a feature node
});

test("resolveBranchRuleNodeIds: feature not in graph -> left unset (validation will report it)", () => {
  const graph = {
    start_node: "ocr",
    nodes: {
      ocr: { node_type: "feature", feature: "OCR", next: "br" },
      br: { node_type: "branch", branches: [
        { id: "a", goto: "s", rules: [{ field: "aml.status", operator: "equals", value: "Clear" }] },
        { id: "else", goto: "s", rules: [] },
      ] },
      s: { node_type: "status", session_status: "Determine" },
    },
  };
  resolveBranchRuleNodeIds(graph);
  assert.equal(graph.nodes.br.branches[0].rules[0].node_id, undefined);
});

test("resolveBranchRuleNodeIds: a downstream same-feature node is never picked", () => {
  const graph = {
    start_node: "ocr_1",
    nodes: {
      ocr_1: { node_type: "feature", feature: "OCR", next: "decide" },
      decide: { node_type: "branch", branches: [
        { id: "recheck", goto: "ocr_2", rules: [{ field: "kyc.status", operator: "equals", value: "Approved" }] },
        { id: "else", goto: "approve", rules: [] },
      ] },
      ocr_2: { node_type: "feature", feature: "OCR", next: "approve" },
      approve: { node_type: "status", session_status: "Approved" },
    },
  };
  resolveBranchRuleNodeIds(graph);
  // ocr_2 runs AFTER the branch, so the rule must read ocr_1, not the deeper ocr_2
  assert.equal(graph.nodes.decide.branches[0].rules[0].node_id, "ocr_1");
});

test("resolveBranchRuleNodeIds: a feature node that owns branches resolves its own feature", () => {
  const graph = {
    start_node: "ocr",
    nodes: {
      ocr: { node_type: "feature", feature: "OCR", branches: [
        { id: "ok", goto: "approve", rules: [{ field: "kyc.status", operator: "equals", value: "Approved" }] },
        { id: "else", goto: "approve", rules: [] },
      ] },
      approve: { node_type: "status", session_status: "Approved" },
    },
  };
  resolveBranchRuleNodeIds(graph);
  assert.equal(graph.nodes.ocr.branches[0].rules[0].node_id, "ocr");
});

// KYC vs KYB segregation: a business workflow verifies a COMPANY, a KYC workflow verifies a PERSON.
// One graph must not mix them — catching both a KYB feature dropped into a KYC flow and a KYC
// feature dropped into a KYB flow. Mirrors the backend WorkflowGraphSerializer rule.

const featureGraph = (...features) => ({
  start_node: features[0].toLowerCase(),
  nodes: Object.fromEntries(features.map((f) => [f.toLowerCase(), { node_type: "feature", feature: f }])),
});

test("segregation: KYB_REGISTRY mixed with OCR is rejected (KYB feature in a KYC flow)", () => {
  assert.throws(() => assertKycKybSegregation(featureGraph("OCR", "KYB_REGISTRY")), /person\/KYC-only/);
});

test("segregation: a KYB flow with person-only LIVENESS is rejected (KYC feature in a KYB flow)", () => {
  assert.throws(() => assertKycKybSegregation(featureGraph("KYB_REGISTRY", "LIVENESS")), /LIVENESS/);
});

test("segregation: pure-KYC graph (OCR + LIVENESS + FACE_MATCH) is allowed", () => {
  assert.doesNotThrow(() => assertKycKybSegregation(featureGraph("OCR", "LIVENESS", "FACE_MATCH")));
});

test("segregation: pure-KYB graph (KYB_REGISTRY + KYB_DOCUMENTS + KYB_KEY_PEOPLE) is allowed", () => {
  assert.doesNotThrow(() =>
    assertKycKybSegregation(featureGraph("KYB_REGISTRY", "KYB_DOCUMENTS", "KYB_KEY_PEOPLE")),
  );
});

test("segregation: KYB combined with shared features (AML, QUESTIONNAIRE, PHONE) is allowed", () => {
  assert.doesNotThrow(() =>
    assertKycKybSegregation(featureGraph("KYB_REGISTRY", "AML", "QUESTIONNAIRE", "PHONE_VERIFICATION")),
  );
});

test("segregation: KYC combined with shared AML (no KYB feature) is not flagged", () => {
  assert.doesNotThrow(() => assertKycKybSegregation(featureGraph("OCR", "AML")));
});

// Regression (prod 2026-07-24, Copilot): a user asked for a company flow whose steps were
// incorporation / ownership / source-of-funds documents. DOCUMENT_AI is KYB-compatible in the
// backend (common/config/choices.py KYBFeatureChoices, and test_kyb_workflow_with_document_ai_is_valid),
// but this list omitted it — so a graph the backend accepts was rejected here, and the agent
// "fixed" the false error by rebuilding the whole thing as a KYC workflow.
test("segregation: DOCUMENT_AI on a KYB graph is allowed (backend KYBFeatureChoices)", () => {
  assert.doesNotThrow(() =>
    assertKycKybSegregation(featureGraph("KYB_REGISTRY", "KYB_DOCUMENTS", "DOCUMENT_AI")),
  );
});
