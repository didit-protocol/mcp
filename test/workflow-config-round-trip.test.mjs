// Round-trip: the config an agent asks for is the config that reaches the API,
// and the config the API stored is what comes back.
//
// The incident was a silent rewrite. The agent sent a DATABASE_VALIDATION node, the
// save succeeded, and the keys were gone - no error, no warning, and no test
// anywhere compared what went in against what came out. These tests do exactly
// that, per feature, over a fake backend that stores the PUT body and serves it
// back: any config the pipeline drops or mutates shows up as a diff instead of
// as a customer report.
//
// The comparison is deliberately byte-level (deepEqual on the whole config
// object). A normalization that IS intended - the documents_allowed shorthands -
// is asserted explicitly, so it stays a documented behaviour rather than an
// unexplained difference.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getWorkflowGraph,
  setWorkflowGraph,
  validateWorkflowGraph,
} from "../dist/tools/workflow-graph.js";
import { requestContext } from "../dist/config.js";

const API = "https://verification.didit.me/v3";
const APP_BASE = `${API}/organization/org-1/application/app-1`;
const SCOPE = { organization_id: "org-1", application_id: "app-1" };
const WF = "wf-round-trip";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const inContext = (fn) => requestContext.run({ accessToken: "tok-round-trip" }, fn);

/**
 * A backend that behaves like the real one for this path: it stores whatever
 * graph is PUT and serves that back, so a value the MCP mangles on the way out
 * cannot be hidden by a canned response.
 */
function fakeBackend() {
  const state = { stored: null, validated: null };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    const method = (init.method ?? "GET").toUpperCase();

    if (path === `${APP_BASE}/verification-settings/${WF}/`) {
      return json({ uuid: WF, status: "draft", workflow_id: WF });
    }
    if (path === `${APP_BASE}/workflow-graph/validate/`) {
      state.validated = JSON.parse(init.body);
      return json({ is_valid: true });
    }
    if (path === `${APP_BASE}/verification-settings/${WF}/workflow-graph/`) {
      if (method === "PUT") {
        state.stored = JSON.parse(init.body).graph;
        return json({ graph: state.stored });
      }
      return json({ graph: state.stored });
    }
    return json({ detail: `Not found: ${method} ${path}` }, 404);
  };
  return state;
}

const featureGraph = (feature, config, extra = {}) => ({
  start_node: "step",
  nodes: {
    step: { node_type: "feature", feature, config, next: "done" },
    done: { node_type: "status", session_status: "Determine" },
    ...extra,
  },
});

/**
 * validate -> set -> get, returning the config the API received and the config
 * it served back. Both are compared against what the caller asked for.
 */
async function roundTrip(feature, config, extra) {
  const state = fakeBackend();
  const asked = structuredClone(config);

  await inContext(() => validateWorkflowGraph(WF, featureGraph(feature, structuredClone(config), extra), SCOPE));
  await inContext(() => setWorkflowGraph(WF, featureGraph(feature, structuredClone(config), extra), false, SCOPE));
  const readBack = await inContext(() => getWorkflowGraph(WF, SCOPE, true));

  return {
    asked,
    sentToValidate: state.validated.graph.nodes.step.config,
    sentToSave: state.stored.nodes.step.config,
    readBack: readBack.graph.nodes.step.config,
  };
}

function assertIdentical(result, message) {
  assert.deepEqual(result.sentToValidate, result.asked, `${message}: validate rewrote the config.`);
  assert.deepEqual(result.sentToSave, result.asked, `${message}: save rewrote the config.`);
  assert.deepEqual(result.readBack, result.asked, `${message}: the stored config did not come back intact.`);
}

// ── Database Validation - the feature the drift silently dropped ─────────────

test("DATABASE_VALIDATION: document_ai field source survives the round trip", async () => {
  const result = await roundTrip("DATABASE_VALIDATION", {
    database_validation_countries: { BRA: { services: ["bra_cpf"] } },
    database_validation_field_sources: {
      tax_id: { source: "document_ai", key: "cpf_number" },
    },
    database_validation_no_match_action: "DECLINE",
  });
  assertIdentical(result, "DATABASE_VALIDATION document_ai");
  assert.deepEqual(result.readBack.database_validation_countries, { BRA: { services: ["bra_cpf"] } });
});

test("DATABASE_VALIDATION: questionnaire field source survives the round trip", async () => {
  const result = await roundTrip("DATABASE_VALIDATION", {
    database_validation_countries: { BRA: { services: ["bra_cpf"] } },
    database_validation_field_sources: {
      mother_name: { source: "questionnaire", key: "q_mother_name" },
    },
    database_validation_partial_match_action: "REVIEW",
  });
  assertIdentical(result, "DATABASE_VALIDATION questionnaire");
});

test("DATABASE_VALIDATION: expected_data field source survives the round trip", async () => {
  const result = await roundTrip("DATABASE_VALIDATION", {
    database_validation_countries: { BRA: { services: ["bra_cpf"] } },
    database_validation_field_sources: {
      tax_id: { source: "expected_data", key: "expected_details.document_number" },
      customer_ref: { source: "expected_data", key: "metadata.customer_ref" },
    },
    database_validation_not_applicable_action: "NO_ACTION",
  });
  assertIdentical(result, "DATABASE_VALIDATION expected_data");
});

test("DATABASE_VALIDATION: a multi-country service selection is not collapsed", async () => {
  const countries = {
    BRA: { services: ["bra_cpf", "bra_cnpj"] },
    MEX: { services: ["mex_curp"] },
    ARG: { services: [] },
  };
  const result = await roundTrip("DATABASE_VALIDATION", {
    database_validation_countries: countries,
    database_validation_no_match_action: "REVIEW",
  });
  assertIdentical(result, "DATABASE_VALIDATION multi-country");
  // The exact failure of that incident: an empty selection must stay empty rather
  // than being "helpfully" filled in, and a filled one must stay filled.
  assert.deepEqual(result.readBack.database_validation_countries, countries);
});

// ── Document AI ─────────────────────────────────────────────────────────────

test("DOCUMENT_AI: multiple documents, every action key and is_full_name survive", async () => {
  const result = await roundTrip("DOCUMENT_AI", {
    document_ai_documents: [
      {
        document_key: "payslip",
        title: "Payslip",
        description: "Most recent payslip",
        fields: [
          { key: "employee_name", name: "Employee name", instruction: "Full legal name", type: "text", required: true, is_full_name: true },
          { key: "net_pay", name: "Net pay", instruction: "Monthly net", type: "number", required: true },
        ],
      },
      {
        document_key: "bank_statement",
        title: "Bank statement",
        description: "Last 3 months",
        fields: [{ key: "iban", name: "IBAN", instruction: "Account IBAN", type: "text", required: false }],
      },
    ],
    document_ai_unreadable_document_action: "REVIEW",
    document_ai_missing_required_fields_action: "REVIEW",
    document_ai_document_tampering_action: "DECLINE",
    document_ai_name_mismatch_action: "REVIEW",
    document_ai_unsupported_file_action: "NO_ACTION",
    document_ai_max_attempts_exceeded_action: "DECLINE",
    document_ai_name_match_score_threshold: 80,
    document_ai_max_retry_attempts: 3,
  });
  assertIdentical(result, "DOCUMENT_AI");
  assert.equal(result.readBack.document_ai_documents[0].fields[0].is_full_name, true);
  assert.equal(result.readBack.document_ai_documents.length, 2);
});

// ── Questionnaire ───────────────────────────────────────────────────────────

test("QUESTIONNAIRE: the questionnaire uuid and review flag survive", async () => {
  const result = await roundTrip("QUESTIONNAIRE", {
    questionnaire_uuid: "11111111-2222-3333-4444-555555555555",
    review_questionnaire_manually: true,
  });
  assertIdentical(result, "QUESTIONNAIRE");
});

// ── Proof of Address ────────────────────────────────────────────────────────

test("PROOF_OF_ADDRESS: a canonical config survives untouched", async () => {
  const result = await roundTrip("PROOF_OF_ADDRESS", {
    poa_documents_allowed: { ESP: { UTILITY_BILL: { enabled: 1 } } },
    poa_languages_allowed: { es: 1, en: 1 },
    poa_name_or_address_mismatch_action: "REVIEW",
    poa_max_retry_attempts: 3,
    poa_name_match_score_threshold: 70,
  });
  assertIdentical(result, "PROOF_OF_ADDRESS canonical");
});

test("PROOF_OF_ADDRESS: a language ARRAY is normalized to the canonical flag map", async () => {
  const state = fakeBackend();
  await inContext(() =>
    setWorkflowGraph(WF, featureGraph("PROOF_OF_ADDRESS", { poa_languages_allowed: ["es", "EN"] }), false, SCOPE),
  );
  // An intended rewrite, asserted so it stays intended: the backend only accepts
  // the flag map, so the MCP converts the shorthand instead of letting the save
  // fail with an opaque error.
  assert.deepEqual(state.stored.nodes.step.config.poa_languages_allowed, { es: 1, en: 1 });
});

// ── OCR documents_allowed, in each accepted input form ──────────────────────

test("OCR: a canonical documents_allowed map is passed through unchanged", async () => {
  const result = await roundTrip("OCR", {
    documents_allowed: { ESP: { P: { enabled: 1 } }, FRA: { ID: { enabled: 1 }, DL: { enabled: 0 } } },
    minimum_age: 18,
    minimum_age_action: "DECLINE",
  });
  assertIdentical(result, "OCR canonical documents_allowed");
});

test("OCR: every documents_allowed shorthand lands on the canonical shape", async () => {
  const cases = [
    { label: "doc-type array", input: ["PASSPORT"], expect: (out) => {
        assert.ok(Object.keys(out).length > 100, "an array must fan out to every country.");
        assert.deepEqual(out.ESP, { P: { enabled: 1 } });
      } },
    { label: "doc NAMES in a per-country map", input: { ESP: { PASSPORT: 1, DRIVER_LICENSE: 1 } }, expect: (out) => {
        assert.deepEqual(out, { ESP: { P: { enabled: 1 }, DL: { enabled: 1 } } });
      } },
    { label: "scalar flags", input: { ESP: { P: true, DL: false } }, expect: (out) => {
        assert.deepEqual(out, { ESP: { P: { enabled: 1 }, DL: { enabled: 0 } } });
      } },
    { label: '"ALL" country key', input: { ALL: { P: 1 } }, expect: (out) => {
        assert.ok(Object.keys(out).length > 100, '"ALL" must fan out to every country.');
        assert.deepEqual(out.BRA, { P: { enabled: 1 } });
      } },
  ];

  for (const { label, input, expect } of cases) {
    const state = fakeBackend();
    await inContext(() =>
      setWorkflowGraph(WF, featureGraph("OCR", { documents_allowed: structuredClone(input) }), false, SCOPE),
    );
    const out = state.stored.nodes.step.config.documents_allowed;
    expect(out, label);
    // Whatever the input form, the sides/subtypes-carrying object shape is what
    // reaches the API - never a bare scalar the backend would reject.
    for (const docs of Object.values(out)) {
      for (const value of Object.values(docs)) {
        assert.equal(typeof value, "object", `${label}: a doc value reached the API as a scalar.`);
        assert.ok("enabled" in value, `${label}: a doc value reached the API without \`enabled\`.`);
      }
    }
  }
});

test("a config key outside the contract is sent verbatim, never silently renamed", async () => {
  // The MCP must not invent a mapping for something it does not understand: the
  // backend is the only authority on what a key means, and a rename here would
  // be a second, invisible contract.
  const result = await roundTrip("DATABASE_VALIDATION", {
    database_validation_countries: { BRA: { services: ["bra_cpf"] } },
    some_future_backend_key: { anything: [1, 2, 3] },
  });
  assert.deepEqual(result.sentToSave.some_future_backend_key, { anything: [1, 2, 3] });
});
