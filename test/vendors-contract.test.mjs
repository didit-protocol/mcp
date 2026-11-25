import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, ORG, OA, backend, call, refusal, request } from "./helpers/console-call.mjs";
import { searchVendorBusinesses, searchVendorUsers } from "../dist/tools/search.js";

// The vendor user and vendor business tools against the People and Companies endpoints.

const ID = "a71f0c2e-5d38-4b96-a1c4-3e9f8d2b7a10";
const USERS = `${OA}/vendor-users`;
const BUSINESSES = `${OA}/vendor-businesses`;
const business = ({ method, path }) => (method === "GET" && path === `${BUSINESSES}/acme/` ? { didit_internal_id: ID, vendor_data: "acme" } : {});

test("a business is updated by its internal id, read from its vendor_data", async (t) => {
  const calls = backend(t, business);
  await call("didit_vendor_business_update", { vendor_data: "acme", legal_name: "Acme SL", reason: "Renamed" });
  assert.deepEqual(calls.map(request), [
    { method: "GET", path: `${BUSINESSES}/acme/`, query: {}, body: undefined },
    { method: "PATCH", path: `${BUSINESSES}/by-id/${ID}/update/`, query: {}, body: { legal_name: "Acme SL", reason: "Renamed" } },
  ]);
});

test("a business that does not exist is not updated", async (t) => {
  const calls = backend(t, () => ({ status: 404, body: { detail: "Not found." } }));
  await assert.rejects(call("didit_vendor_business_update", { vendor_data: "nobody", legal_name: "X" }), refusal({ status: 404 }));
  assert.equal(calls.length, 1);
});

test("a status change goes through the profile update, with its reason", async (t) => {
  const calls = backend(t, business);
  await call("didit_vendor_business_update_status", { vendor_data: "acme", status: "BLOCKED", reason: "Sanctions" });
  await call("didit_vendor_user_update_status", { vendor_data: "u 1", status: "FLAGGED" });
  assert.deepEqual(calls.slice(1).map(request), [
    { method: "PATCH", path: `${BUSINESSES}/by-id/${ID}/update/`, query: {}, body: { status: "BLOCKED", reason: "Sanctions" } },
    { method: "PATCH", path: `${USERS}/u%201/update/`, query: {}, body: { status: "FLAGGED" } },
  ]);
});

test("businesses named by vendor_data are deleted by their internal ids", async (t) => {
  const calls = backend(t, business);
  await call("didit_vendor_business_delete", { vendor_data_list: ["acme"], didit_internal_id_list: ["other"], confirm: true });
  assert.deepEqual(request(calls.at(-1)), {
    method: "DELETE", path: `${BUSINESSES}/delete/`, query: {}, body: { didit_internal_id_list: ["other", ID], delete_all: false },
  });

  await call("didit_vendor_business_delete", { delete_all: true, confirm: true });
  assert.deepEqual(calls.at(-1).body, { delete_all: true });
});

test("one business that cannot be found deletes none", async (t) => {
  const calls = backend(t, (sent) => (sent.path.endsWith("/nobody/") ? { status: 404, body: { detail: "Not found." } } : business(sent)));
  await assert.rejects(call("didit_vendor_business_delete", { vendor_data_list: ["acme", "nobody"], confirm: true }), refusal({ status: 404 }));
  assert.ok(calls.every(({ method }) => method === "GET"));
});

test("the lists take the filters of the People and Companies lists", async (t) => {
  const calls = backend(t, () => ({ count: 0, results: [] }));
  const filters = { status: "FLAGGED", search: "ada", risk: "HIGH", tag: "t1", latest_verification_status: "In Review", ordering: "-created_at", limit: "5", offset: "10" };
  await call("didit_vendor_user_list", { ...filters, country: "ESP" });
  await call("didit_vendor_business_list", { ...filters, country: "ES" });
  assert.deepEqual(calls.map(request), [
    { method: "GET", path: `${USERS}/`, query: { ...filters, country: "ESP" }, body: undefined },
    { method: "GET", path: `${BUSINESSES}/`, query: { ...filters, country: "ES" }, body: undefined },
  ]);
});

test("vendor_data is searched, since the lists have no such filter", async (t) => {
  const calls = backend(t, () => ({ count: 0, results: [] }));
  const scope = { organization_id: ORG, application_id: APP };
  await searchVendorUsers({ ...scope, vendor_data: "u1" });
  await searchVendorBusinesses({ ...scope, vendor_data: "acme" });
  assert.deepEqual(calls.map(({ query }) => query), [{ search: "u1", limit: "20" }, { search: "acme", limit: "20" }]);
  await assert.rejects(searchVendorUsers({ ...scope, vendor_data: "u1", search: "ada" }), refusal({ code: "bad_request", field: "vendor_data" }));
});

test("a person is created with a contact, and emailed a link only when confirmed", async (t) => {
  const calls = backend(t);
  const ada = { vendor_data: "u1", first_name: "Ada", last_name: "Lovelace", email: "ada@acme.com", country: "ES" };
  await call("didit_vendor_user_create", ada);
  assert.deepEqual(request(calls[0]), { method: "POST", path: `${USERS}/`, query: {}, body: ada });

  const link = { ...ada, send_verification_link: true, workflow_id: "wf", language: "es" };
  await assert.rejects(call("didit_vendor_user_create", link), refusal({ code: "unsafe_operation", field: "confirm" }));
  await call("didit_vendor_user_create", { ...link, confirm: true });
  assert.deepEqual(calls.at(-1).body, link);
});

test("a pasted list of people is looked up and read in one call", async (t) => {
  const calls = backend(t, ({ method }) =>
    method === "POST" ? { lookup_id: "k1", requested: 2, found: 1, not_found: [{ identifier: "x", position: 2 }] } : { count: 1, results: [{ vendor_data: "u1" }] });
  const found = await call("didit_vendor_user_lookup", { identifiers: ["u1", "x"], limit: 10 });
  assert.deepEqual(calls.map(request), [
    { method: "POST", path: `${USERS}/lookup/`, query: {}, body: { identifiers: ["u1", "x"] } },
    { method: "GET", path: `${USERS}/`, query: { lookup: "k1", limit: "10" }, body: undefined },
  ]);
  assert.equal(found.not_found[0].identifier, "x");
  assert.deepEqual(found.results, [{ vendor_data: "u1" }]);

  t.mock.restoreAll();
  backend(t, () => ({ status: 403, body: { detail: "You do not have permission." } }));
  await assert.rejects(call("didit_vendor_user_lookup", { identifiers: ["u1"] }), refusal({ status: 403 }));
});
