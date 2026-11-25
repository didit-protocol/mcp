import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, ORG, OA, backend, call, refusal, request } from "./helpers/console-call.mjs";
import { searchCases } from "../dist/tools/search.js";

// The case tools against the contract of the case endpoints (applications/views/case_management.py).

const CASE = "5e1d2a70-3b94-4c1f-8a6e-d2f07b9c1e35";
const CASES = `${OA}/cases`;

/** What each action sends: [action, data, method, path under the case, body]. */
const ACTIONS = [
  ["assign", { assignee_user_id: null }, "POST", "assign/", { assignee_user_id: null }],
  ["update", { priority: "HIGH", team: null }, "PATCH", "", { priority: "HIGH", team: null }],
  ["resolve", { resolution: "FALSE_POSITIVE", note: "Same name, other person" }, "POST", "resolve/", { resolution: "FALSE_POSITIVE", note: "Same name, other person" }],
  ["reopen", undefined, "POST", "reopen/", {}],
  ["escalate", { comment: "Second opinion" }, "POST", "escalate/", { comment: "Second opinion" }],
  ["request_info", undefined, "POST", "request-info/", {}],
  ["note", { comment: "Called them", is_internal: true }, "POST", "notes/", { comment: "Called them", is_internal: true }],
  ["comment", { comment: "Called them" }, "POST", "notes/", { comment: "Called them" }],
  ["link", { entity_type: "session", entity_uuid: "s1" }, "POST", "links/", { entity_type: "session", entity_uuid: "s1" }],
  ["unlink", { link_uuid: "l1" }, "DELETE", "links/l1/", undefined],
  ["checklist", { item_uuid: "i1", is_completed: true }, "PATCH", "checklist/i1/", { is_completed: true }],
  ["transfer", { target_blueprint: "b1" }, "POST", "transfer/", { target_blueprint: "b1" }],
  ["entity_action", { action: "set_status", status: "BLOCKED" }, "POST", "entity-actions/", { action: "set_status", status: "BLOCKED" }],
  ["reject_approval", { notes: "Not enough evidence" }, "POST", "reject-approval/", { notes: "Not enough evidence" }],
];
const CONFIRMED = ["resolve", "entity_action", "reject_approval"];

test("every case action calls its own endpoint", async (t) => {
  const calls = backend(t);
  for (const [action, data, method, path, body] of ACTIONS) {
    await call("didit_case_manage", { case_id: CASE, action, data, confirm: true });
    assert.deepEqual(request(calls.at(-1)), { method, path: `${CASES}/${CASE}/${path}`, query: {}, body }, action);
  }
});

test("an action that decides needs confirm:true, and the others do not", async (t) => {
  const calls = backend(t);
  for (const [action, data] of ACTIONS) {
    const run = call("didit_case_manage", { case_id: CASE, action, data });
    if (CONFIRMED.includes(action)) await assert.rejects(run, refusal({ code: "unsafe_operation", field: "confirm" }), action);
    else await run;
  }
  assert.equal(calls.length, ACTIONS.length - CONFIRMED.length);
});

test("an unknown action, a field its action ignores and a missing id are refused", async (t) => {
  const calls = backend(t);
  for (const [args, field] of [
    [{ action: "file_sar", confirm: true }, "action"],
    [{ action: "update", data: { status: "RESOLVED" } }, "data"],
    [{ action: "unlink", data: {} }, "link_uuid"],
  ]) {
    await assert.rejects(call("didit_case_manage", { case_id: CASE, ...args }), refusal({ code: "bad_request", field }), JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
});

test("the refusal of a plan without Cases passes through", async (t) => {
  backend(t, () => ({ status: 403, body: { code: "plan_upgrade_required", detail: "Your plan does not include Cases." } }));
  await assert.rejects(call("didit_case_manage", { case_id: CASE, action: "reopen" }), refusal({ status: 403, message: /does not include Cases/ }));
});

test("the list filters by status__in, like the API, and pages with limit and offset", async (t) => {
  const calls = backend(t, () => ({ count: 0, results: [] }));
  await call("didit_case_list", { status: "open,AWAITING_USER", priority: "HIGH", assignee: "me", overdue: true, tag: "pep", ordering: "due_at", limit: 10, offset: 20 });
  assert.deepEqual(calls.map(request), [{
    method: "GET",
    path: `${CASES}/`,
    query: { status__in: "OPEN,AWAITING_USER", priority: "HIGH", assignee: "me", overdue: "true", tag: "pep", ordering: "due_at", limit: "10", offset: "20" },
    body: undefined,
  }]);
});

test("the search across applications sends the same filters", async (t) => {
  const calls = backend(t, () => ({ count: 0, results: [] }));
  await searchCases({ organization_id: ORG, application_id: APP, status: "RESOLVED", search: "CS-0001" });
  assert.deepEqual(calls[0].query, { status__in: "RESOLVED", search: "CS-0001", limit: "20" });
});

test("a case comes with the parts asked for", async (t) => {
  const calls = backend(t, ({ path }) => (path === `${CASES}/${CASE}/` ? { uuid: CASE, title: "Structuring" } : [{ path }]));
  const found = await call("didit_case_get", { case_id: CASE, include: ["notes", "aml"] });
  assert.deepEqual(calls.map(({ path }) => path).sort(), [`${CASES}/${CASE}/`, `${CASES}/${CASE}/aml/`, `${CASES}/${CASE}/notes/`]);
  assert.equal(found.title, "Structuring");
  assert.deepEqual(found.included, { notes: [{ path: `${CASES}/${CASE}/notes/` }], aml: [{ path: `${CASES}/${CASE}/aml/` }] });

  await call("didit_case_get", { case_id: CASE });
  assert.equal(calls.length, 4, "nothing more than the case unless asked");
  await assert.rejects(call("didit_case_get", { case_id: CASE, include: ["print"] }), refusal({ code: "bad_request", field: "include" }));
});

test("the catalogs a case takes its ids from", async (t) => {
  const calls = backend(t, () => ({ results: [] }));
  for (const [kind, path] of [
    ["reviewers", `${CASES}/reviewers/`],
    ["teams", `${CASES}/teams/`],
    ["blueprints", `${CASES}/blueprints/`],
    ["presets", `${CASES}/blueprints/presets/`],
    ["report_templates", `${OA}/report-templates/`],
  ]) {
    await call("didit_case_catalog_list", { kind, limit: 5 });
    assert.deepEqual(request(calls.at(-1)), { method: "GET", path, query: { limit: "5" }, body: undefined }, kind);
  }
  await assert.rejects(call("didit_case_catalog_list", { kind: "rules" }), refusal({ code: "bad_request", field: "kind" }));
});
