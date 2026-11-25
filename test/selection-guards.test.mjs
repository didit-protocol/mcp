import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { narrowingFilters } from "../dist/security.js";
import { REGISTERED_TOOLS } from "../dist/tools/registered.js";

// An action on "everything that matches" or on a list of records acts on those records and no others:
// a backend drops a blank filter and then takes every record, and prefers "all" over a list of ids.

const OA = "/v3/organization/org-1/application/app-1";
const ID = "6e5d4c3b-0f9e-4d6c-8b5a-2e1f2a3b4c5d";

function backend(t, reply = () => ({})) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const sent = { method: init.method ?? "GET", path: new URL(String(url)).pathname, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(sent);

    return Response.json(reply(sent));
  });

  return calls;
}

const call = async (name, args) =>
  requestContext.run({ accessToken: "t", organizationId: "org-1", applicationId: "app-1" }, () => REGISTERED_TOOLS.get(name).run(args));
const refusedOn = (field) => (error) => error.shape.field === field;

const BLANK = [{}, [], "status", { status: [""] }, { status: [null] }, { status: [] }, { vendor_data: "  " }, { status: "," }, { status: "Approved," }, { country: " " }, { status: false }, { date_from: "yesterday" }, { delete_all: "x" }];

test("a filter that would not narrow anything is refused", () => {
  const allowed = ["status", "vendor_data", "country", "date_from"];
  for (const filters of BLANK) assert.throws(() => narrowingFilters(filters, allowed), refusedOn("filters"), JSON.stringify(filters));
  assert.deepEqual(narrowingFilters({ status: "Approved,Declined", date_from: "2026-11-01" }, allowed), { status: "Approved,Declined", date_from: "2026-11-01" });
});

test("a filtered delete_all of sessions never runs unfiltered", async (t) => {
  const calls = backend(t);
  for (const filters of [...BLANK, { tags: "," }, { status_initialized_as_in_review: false }]) {
    await assert.rejects(call("didit_session_batch_delete", { delete_all: true, confirm: true, filters }), refusedOn("filters"), JSON.stringify(filters));
  }
  assert.equal(calls.length, 0);
  await call("didit_session_batch_delete", { delete_all: true, confirm: true, filters: { status: ["Expired"] } });
  assert.deepEqual(calls, [{ method: "DELETE", path: `${OA}/sessions/delete/`, body: { delete_all: true, filter_status: ["Expired"] } }]);
});

test("businesses are deleted only when listed, confirmed and found", async (t) => {
  const calls = backend(t, ({ path }) => ({ didit_internal_id: path.includes("acme") ? ID : undefined }));
  await assert.rejects(call("didit_vendor_business_delete", { vendor_data_list: ["acme"] }), refusedOn("confirm"));
  await assert.rejects(call("didit_vendor_business_delete", { vendor_data_list: "42", confirm: true }), refusedOn("vendor_data_list"));
  await assert.rejects(call("didit_vendor_business_delete", { didit_internal_id_list: [""], confirm: true }), refusedOn("didit_internal_id_list"));
  await assert.rejects(call("didit_vendor_business_delete", { vendor_data_list: Array(201).fill("acme"), confirm: true }), refusedOn("vendor_data_list"));
  assert.equal(calls.length, 0);
  await call("didit_vendor_business_delete", { vendor_data_list: ["acme"], confirm: true });
  assert.deepEqual(calls.at(-1), { method: "DELETE", path: `${OA}/vendor-businesses/delete/`, body: { didit_internal_id_list: [ID], delete_all: false } });
});

test("monitoring covers the records named or the filtered ones, never everyone by accident", async (t) => {
  const calls = backend(t);
  const run = (args) => call("didit_monitoring_update", { target: "vendor_users", is_enabled: true, ...args });
  await assert.rejects(run({ didit_internal_ids: [ID], update_all: true }), refusedOn("didit_internal_ids"));
  await assert.rejects(run({ didit_internal_ids: [ID], filters: { toggle_all: true } }), refusedOn("didit_internal_ids"));
  await assert.rejects(run({}), refusedOn("didit_internal_ids"));
  for (const filters of [...BLANK, { filter_status: ["ACTIVE"] }, { toggle_all: "true" }]) await assert.rejects(run({ update_all: true, filters }), refusedOn("filters"), JSON.stringify(filters));
  assert.equal(calls.length, 0);
  await run({ update_all: true, filters: { status: "ACTIVE,FLAGGED", country: "ES" } });
  assert.deepEqual(calls.at(-1).body, { update_all: true, filter_status: ["ACTIVE", "FLAGGED"], filter_country: "ES", is_enabled: true, estimate_only: true });
});

test("actions carry action fields only, and replace no argument", async (t) => {
  const calls = backend(t);
  await assert.rejects(call("didit_verify_phone_check", { phone_number: "+34600000012", code: "123456", actions: { factor_id: "f" } }), refusedOn("actions"));
  await assert.rejects(call("didit_verify_email_check", { email: "a@example.com", code: "123456", actions: { code: "9" } }), refusedOn("actions"));
  assert.equal(calls.length, 0);
});

test("an export takes a listed kind, a webhook keeps at least one event, a case list a day and no cursor", async (t) => {
  const calls = backend(t);
  await assert.rejects(call("didit_report_export", { kind: "schedules", data: {} }), refusedOn("kind"));
  await assert.rejects(call("didit_webhook_update", { destination_uuid: ID, subscribed_events: [] }), refusedOn("subscribed_events"));
  await assert.rejects(call("didit_case_list", { cursor: "abc" }), refusedOn("cursor"));
  await assert.rejects(call("didit_regulatory_report_list", { case_id: "12" }), refusedOn("case_id"));
  assert.equal(calls.length, 0);
});
