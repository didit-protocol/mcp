import { test } from "node:test";
import assert from "node:assert/strict";
import { OA, SESSION, backend, call, refusal, request } from "./helpers/console-call.mjs";
import { REGISTERED_TOOLS } from "../dist/tools/registered.js";
import { toolGroupOf, toolsetOf } from "../dist/toolsets.js";

// What a reviewer does on one session: follow a deletion, take its files, decide AML hits and single
// checks, preview an email, and act on a business verification's key people.

const JOB = "6a2f8b13-4c75-49d0-9e8b-1f3a5c7d9b21";
const PARTY = "5e1d2a70-3b94-4c1f-8a6e-d2f07b9c1e35";
const ID = `/session/${SESSION}`;

/** [tool, args, method, path, query, body] */
const REQUESTS = [
  ["didit_session_deletion_get", { job_id: JOB }, "GET", `${OA}/sessions/delete/${JOB}/`, {}, undefined],
  ["didit_session_files_create", { session_id: SESSION }, "POST", `${ID}/files-export/`, {}, undefined],
  ["didit_session_files_get", { session_id: SESSION, export_id: JOB }, "GET", `${ID}/files-export/${JOB}/`, {}, undefined],
  ["didit_session_aml_update", { session_id: SESSION, hits: [{ hit_id: "hit_1", review_status: "False Positive" }], node_id: "aml_1", confirm: true }, "PATCH", `${ID}/bulk-update-aml-hit-status/`, { node_id: "aml_1" }, { hit_updates: [{ hit_id: "hit_1", review_status: "False Positive" }] }],
  ["didit_session_aml_update", { session_id: SESSION, status: "Declined", confirm: true }, "PATCH", `${ID}/update-aml-status/`, {}, { status: "Declined" }],
  ["didit_session_aml_history_list", { session_id: SESSION, month: "2026-10", limit: 5 }, "GET", `${ID}/aml-screening-history/`, { month: "2026-10", limit: "5" }, undefined],
  ["didit_session_feature_override_list", { session_id: SESSION }, "GET", `${ID}/features/overrides/`, {}, undefined],
  ["didit_session_feature_override_update", { session_id: SESSION, node_id: "feature_ocr", new_status: "Approved", comment: "Seen", defer_until_flow_finishes: true, confirm: true }, "PATCH", `${ID}/features/feature_ocr/update-status/`, {}, { new_status: "Approved", comment: "Seen", defer_until_flow_finishes: true }],
  ["didit_session_feature_override_update", { session_id: SESSION, cancel_override_id: JOB, confirm: true }, "POST", `${ID}/features/overrides/${JOB}/cancel/`, {}, {}],
  ["didit_session_email_preview", { session_id: SESSION, kind: "decision", new_status: "Declined", email_language: "es" }, "POST", `${ID}/decision-email-preview/`, {}, { new_status: "Declined", email_language: "es" }],
  ["didit_session_email_preview", { session_id: SESSION, kind: "resubmission", nodes_to_resubmit: [{ node_id: "n", feature: "OCR" }], email_address: "a@b.co" }, "POST", `${ID}/resubmission-preview/`, {}, { nodes_to_resubmit: [{ node_id: "n", feature: "OCR" }], email_address: "a@b.co" }],
  ["didit_kyb_party_update", { session_id: SESSION, party_id: PARTY, action: "skip", confirm: true }, "PATCH", `${ID}/kyb/parties/${PARTY}/`, {}, { is_skipped: true }],
  ["didit_kyb_party_update", { session_id: SESSION, party_id: PARTY, action: "unskip", confirm: true }, "PATCH", `${ID}/kyb/parties/${PARTY}/`, {}, { is_skipped: false }],
  ["didit_kyb_party_update", { session_id: SESSION, party_id: PARTY, action: "regenerate", confirm: true }, "POST", `${ID}/kyb/parties/${PARTY}/regenerate/`, {}, {}],
  ["didit_kyb_party_update", { session_id: SESSION, company_id: PARTY, company_data: { company_name: "Acme SL" } }, "PATCH", `${ID}/kyb/${PARTY}/update-data/`, {}, { company_name: "Acme SL" }],
];

test("every tool calls its own endpoint", async (t) => {
  const calls = backend(t);
  for (const [name, args, method, path, query, body] of REQUESTS) {
    await call(name, args);
    assert.deepEqual(request(calls.at(-1)), { method, path, query, body }, name);
  }
});

test("what decides, or contacts a person, needs confirm:true", async (t) => {
  const calls = backend(t);
  for (const [name, { confirm, ...args }] of REQUESTS.filter(([, args]) => args.confirm)) {
    await assert.rejects(call(name, args), refusal({ code: "unsafe_operation", field: "confirm" }), name);
    assert.equal(REGISTERED_TOOLS.get(name).access, "destructive", name);
  }
  assert.equal(calls.length, 0);
});

test("a call that names two things to change, or none, is refused", async (t) => {
  const calls = backend(t);
  for (const [name, args, field] of [
    ["didit_session_aml_update", { confirm: true }, "hits"],
    ["didit_session_aml_update", { hits: [{ hit_id: "h", review_status: "Inconclusive" }], status: "Approved", confirm: true }, "hits"],
    ["didit_session_feature_override_update", { confirm: true }, "node_id"],
    ["didit_session_email_preview", { kind: "welcome" }, "kind"],
    ["didit_kyb_party_update", { confirm: true }, "party_id"],
    ["didit_kyb_party_update", { party_id: PARTY, action: "delete", confirm: true }, "action"],
    ["didit_kyb_party_update", { company_id: PARTY, company_data: { legal_name: "x" } }, "company_data"],
    ["didit_kyb_party_update", { company_id: PARTY, company_data: {} }, "company_data"],
  ]) {
    await assert.rejects(call(name, { session_id: SESSION, ...args }), refusal({ code: "bad_request", field }), `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, 0);
});

test("a preview keeps the text of the email and leaves its HTML out", async (t) => {
  backend(t, () => ({ recipient: "a@b.co", text: "Approved", html: "<img src=data:...>", preview_token: "r" }));
  assert.deepEqual(await call("didit_session_email_preview", { session_id: SESSION, kind: "decision", new_status: "Approved" }), {
    recipient: "a@b.co", text: "Approved", preview_token: "r",
  });
});

test("an API refusal comes back as it is", async (t) => {
  for (const [name, args] of REQUESTS) {
    t.mock.restoreAll();
    backend(t, () => ({ status: 403, body: { detail: "You do not have permission to perform this action." } }));
    await assert.rejects(call(name, args), refusal({ status: 403, message: /permission/ }), name);
  }
});

test("a business verification's key people sit with the sessions", () => {
  assert.equal(toolsetOf("didit_kyb_party_update"), "sessions");
  assert.equal(toolGroupOf("didit_kyb_party_update"), "Sessions");
  assert.equal(REGISTERED_TOOLS.get("didit_kyb_party_update").permission, "write:businesses");
});
