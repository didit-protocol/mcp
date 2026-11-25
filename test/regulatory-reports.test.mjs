import { test } from "node:test";
import assert from "node:assert/strict";
import { OA, backend, call, refusal, request } from "./helpers/console-call.mjs";
import { REGISTERED_TOOLS } from "../dist/tools/registered.js";
import { toolGroupOf, toolsetOf } from "../dist/toolsets.js";

// Draft regulatory reports (applications/views/regulatory_reports.py). No tool finalizes or deletes one.

const CASE = "5e1d2a70-3b94-4c1f-8a6e-d2f07b9c1e35";
const REPORT = "a71f0c2e-5d38-4b96-a1c4-3e9f8d2b7a10";
const REPORTS = `${OA}/regulatory-reports/`;

test("the list narrows by status, type and case, and refuses a filter the API would ignore", async (t) => {
  const calls = backend(t, () => ({ count: 0, results: [] }));
  await call("didit_regulatory_report_list", { status: "DRAFT", report_type: "SAR", case_id: CASE, limit: 10 });
  assert.deepEqual(calls.map(request), [
    { method: "GET", path: REPORTS, query: { status: "DRAFT", report_type: "SAR", case: CASE, limit: "10" }, body: undefined },
  ]);
  await assert.rejects(call("didit_regulatory_report_list", { status: "FILED" }), refusal({ code: "bad_request", field: "status" }));
});

test("a report comes with the link of its file when asked", async (t) => {
  const calls = backend(t, ({ path }) => (path.endsWith("download-url/") ? { download_url: "https://files/x.pdf", file: "pdf" } : { uuid: REPORT, status: "FINALIZED" }));
  assert.deepEqual(await call("didit_regulatory_report_get", { report_id: REPORT }), { uuid: REPORT, status: "FINALIZED" });
  const found = await call("didit_regulatory_report_get", { report_id: REPORT, file: "pdf" });
  assert.equal(found.download_url, "https://files/x.pdf");
  assert.deepEqual(request(calls.at(-1)), { method: "GET", path: `${REPORTS}${REPORT}/download-url/`, query: { file: "pdf" }, body: undefined });
});

test("a draft is created on its case", async (t) => {
  const calls = backend(t);
  await call("didit_regulatory_report_create", {
    case_id: CASE, report_type: "STR", jurisdiction: "AE", narrative: { who: "Ada", why: "Structuring" }, fields: { reason: "Cash", submission_code: "E" },
  });
  assert.deepEqual(calls.map(request), [{
    method: "POST",
    path: `${OA}/cases/${CASE}/regulatory-reports/`,
    query: {},
    body: { report_type: "STR", jurisdiction: "AE", narrative: { who: "Ada", why: "Structuring" }, reason: "Cash", submission_code: "E" },
  }]);
  await assert.rejects(call("didit_regulatory_report_create", { case_id: CASE, fields: { status: "FINALIZED" } }), refusal({ code: "bad_request", field: "fields" }));
});

test("a draft is edited, validated, or both", async (t) => {
  const calls = backend(t, ({ path }) => (path.endsWith("validate/") ? { status: "VALIDATED", is_valid: true, errors: [] } : { uuid: REPORT }));
  const both = await call("didit_regulatory_report_update", { report_id: REPORT, fields: { action: "Reported" }, validate: true });
  assert.deepEqual(calls.map(request), [
    { method: "PATCH", path: `${REPORTS}${REPORT}/`, query: {}, body: { action: "Reported" } },
    { method: "POST", path: `${REPORTS}${REPORT}/validate/`, query: {}, body: {} },
  ]);
  assert.equal(both.validation.is_valid, true);

  await call("didit_regulatory_report_update", { report_id: REPORT, validate: true });
  assert.equal(calls.length, 3, "only the validation");
  await assert.rejects(call("didit_regulatory_report_update", { report_id: REPORT }), refusal({ code: "bad_request" }));
});

test("a finalized report answers 409, and no tool finalizes or deletes one", async (t) => {
  backend(t, () => ({ status: 409, body: { detail: "Finalized reports cannot be edited." } }));
  await assert.rejects(call("didit_regulatory_report_update", { report_id: REPORT, fields: { action: "x" } }), refusal({ status: 409 }));
  const names = [...REGISTERED_TOOLS.keys()].filter((name) => name.startsWith("didit_regulatory_"));
  assert.deepEqual(names.map((name) => name.split("_").at(-1)).sort(), ["create", "get", "list", "update"]);
  assert.equal(toolsetOf("didit_regulatory_report_list"), "cases");
  assert.equal(toolGroupOf("didit_regulatory_report_list"), "Cases");
});
