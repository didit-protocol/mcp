import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTH, APP, ORG, OA, SESSION, backend, call, refusal, request } from "./helpers/console-call.mjs";
import { searchSessions } from "../dist/tools/search.js";

// The session tools against the contract of the session endpoints: exact method, path, query and
// body of what each one sends, and what each one refuses before sending anything.

// ── Bulk deletion ───────────────────────────────────────────────────────────────────────────────

const kycNumbers = (numbers) => ({ path, query }) => {
  if (!path.endsWith("/sessions/")) return { results: [] };
  const number = Number(query.search?.replace("S-", ""));
  return { count: 1, results: numbers.includes(number) ? [{ session_id: SESSION, session_number: number, session_kind: "user" }] : [] };
};

test("a deletion by numbers checks that each one is a user verification first", async (t) => {
  const calls = backend(t, (sent) => (sent.method === "DELETE" ? { results: [{ session_number: 7, outcome: "deleted" }] } : kycNumbers([7, 9])(sent)));
  const result = await call("didit_session_batch_delete", { session_numbers: [7, "9", 7], confirm: true });

  assert.deepEqual(calls.slice(0, -1).map(request), [
    { method: "GET", path: `${OA}/sessions/`, query: { search: "S-7", fields: "ids", limit: "1" }, body: undefined },
    { method: "GET", path: `${OA}/sessions/`, query: { search: "S-9", fields: "ids", limit: "1" }, body: undefined },
  ]);
  assert.deepEqual(request(calls.at(-1)), {
    method: "DELETE", path: `${OA}/sessions/delete/`, query: {}, body: { session_numbers: [7, 9], delete_all: false },
  });
  assert.equal(result.results.length, 1);
});

test("a number with no user verification refuses the whole deletion, naming it", async (t) => {
  // The console route deletes the business verification with that number instead.
  const calls = backend(t, kycNumbers([7]));
  await assert.rejects(
    call("didit_session_batch_delete", { session_numbers: [7, 8, 12], confirm: true }),
    refusal({ code: "bad_request", field: "session_numbers", message: /8, 12/ }),
  );
  assert.ok(calls.every((sent) => sent.method === "GET"), "nothing was deleted");
});

test("a lookup that fails deletes nothing", async (t) => {
  const calls = backend(t, () => ({ status: 403, body: { detail: "You do not have permission." } }));
  await assert.rejects(call("didit_session_batch_delete", { session_numbers: [7], confirm: true }), refusal({ status: 403 }));
  assert.ok(calls.every((sent) => sent.method === "GET"));
});

test("delete_all sends its filters and retention, and a job comes back with how to follow it", async (t) => {
  const job = { job_id: "6a2f8b13-4c75-49d0-9e8b-1f3a5c7d9b21", status: "PENDING", total: 240 };
  const calls = backend(t, () => ({ status: 202, body: job }));
  const result = await call("didit_session_batch_delete", {
    delete_all: true,
    confirm: true,
    filters: { status: "Expired", vendor_data: "user-1" },
    retention: { retain_face_embeddings: true, face_retention_days: 30 },
  });

  assert.deepEqual(calls.map(request), [{
    method: "DELETE",
    path: `${OA}/sessions/delete/`,
    query: {},
    body: { delete_all: true, filter_status: "Expired", filter_vendor_data: "user-1", retain_face_embeddings: true, face_retention_days: 30 },
  }]);
  assert.equal(result.job_id, job.job_id);
  assert.match(result.hint, /didit_session_deletion_get/);
});

test("a deletion never widens: a blank filter, filters without delete_all and an unknown option are refused", async (t) => {
  const calls = backend(t);
  for (const [args, field] of [
    [{ delete_all: true, filters: { status: "" } }, "filters"],
    [{ delete_all: true, filters: {} }, "filters"],
    [{ session_numbers: [7], filters: { status: "Expired" } }, "filters"],
    [{ delete_all: true, retention: { keep_faces: true } }, "retention"],
    [{ session_numbers: ["B-7"] }, "session_numbers"],
  ]) {
    await assert.rejects(call("didit_session_batch_delete", { ...args, confirm: true }), refusal({ code: "bad_request", field }), JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
});

// ── Lists: user, business or both ───────────────────────────────────────────────────────────────

test("session_kind business reads the business list, with the filters", async (t) => {
  const calls = backend(t, () => ({ count: 1, results: [{ session_number: 3 }] }));
  await call("didit_session_list", { session_kind: "business", status: "In Review", tags: "t1", limit: "5" });
  assert.deepEqual(calls.map(request), [
    { method: "GET", path: `${OA}/business-sessions/`, query: { status: "In Review", tags: "t1", limit: "5" }, body: undefined },
  ]);
});

test("the user list is the default and never sends session_kind", async (t) => {
  const calls = backend(t, () => ({ count: 0, results: [] }));
  await call("didit_session_list", { session_kind: "user", assignee: "me", country: "ESP", document_type: "P", ordering: "-updated_at", decided_from: "2026-11-01T00:00:00Z" });
  assert.deepEqual(calls.map(request), [{
    method: "GET",
    path: `${OA}/sessions/`,
    query: { assignee: "me", country: "ESP", document_type: "P", ordering: "-updated_at", decided_from: "2026-11-01T00:00:00Z" },
    body: undefined,
  }]);
});

test("a capped business list is counted as business sessions", async (t) => {
  const calls = backend(t, ({ path }) => (path === "/sessions/counts/" ? { views: { all: 412 } } : { count: 100, results: [] }));
  const page = await call("didit_session_list", { session_kind: "business" });
  assert.equal(page.total_count, 412);
  assert.equal(calls.at(-1).query.session_kind, "business");
});

test("all reads both lists, newest first, and says when one could not be read", async (t) => {
  const rows = {
    [`${OA}/sessions/`]: [{ session_id: "u1", created_at: "2026-11-02T00:00:00Z" }],
    [`${OA}/business-sessions/`]: [{ session_id: "b1", created_at: "2026-11-03T00:00:00Z" }],
  };
  let denied = false;
  backend(t, ({ path }) => (denied && path.includes("business") ? { status: 403, body: { detail: "no" } } : { count: 1, results: rows[path] }));

  const both = await call("didit_session_list", { session_kind: "all" });
  assert.deepEqual(both.results.map((row) => [row.session_id, row.session_kind]), [["b1", "business"], ["u1", "user"]]);
  assert.equal(both.count, 2);

  denied = true;
  const partial = await call("didit_session_list", { session_kind: "all" });
  assert.deepEqual(partial.results.map((row) => row.session_id), ["u1"]);
  assert.match(partial.left_out_note, /business verifications/);

  denied = false;
  const one = await call("didit_session_list", { session_kind: "all", limit: "1" });
  assert.deepEqual(one.results.map((row) => row.session_id), ["b1"]);
  await assert.rejects(call("didit_session_list", { session_kind: "all", ordering: "created_at" }), refusal({ field: "ordering" }));
  await assert.rejects(call("didit_session_list", { session_kind: "all", offset: "20" }), refusal({ field: "offset" }));
  await assert.rejects(call("didit_session_list", { session_kind: "all", country: "ESP" }), refusal({ field: "country" }));
  await assert.rejects(call("didit_session_list", { session_kind: "business", document_type: "P" }), refusal({ field: "document_type" }));
});

test("a search of business sessions in one application reads the business list", async (t) => {
  const calls = backend(t, () => ({ count: 1, results: [{ session_number: 3 }] }));
  const found = await searchSessions({ organization_id: ORG, application_id: APP, session_kind: "business", search: "B-3" });
  assert.equal(found.results.length, 1);
  assert.deepEqual(calls.map(request), [
    { method: "GET", path: `${OA}/business-sessions/`, query: { search: "B-3", limit: "20" }, body: undefined },
  ]);
});

// ── Reviews, sharing, imports ───────────────────────────────────────────────────────────────────

test("a review note sends the comment alone", async (t) => {
  const calls = backend(t);
  await call("didit_session_add_review", { session_id: SESSION, comment: "Checked", new_status: "Approved" });
  assert.deepEqual(calls.map(request), [
    { method: "POST", path: `${OA}/sessions/${SESSION}/reviews/`, query: {}, body: { comment: "Checked" } },
  ]);
});

test("a status change sends the steps to resubmit as {node_id, feature}", async (t) => {
  const calls = backend(t);
  const nodes_to_resubmit = [{ node_id: "feature_ocr", feature: "OCR" }];
  await call("didit_session_update_status", { session_id: SESSION, new_status: "Resubmitted", nodes_to_resubmit, send_email: true, email_address: "a@b.co", email_preview_token: "r" });
  assert.deepEqual(calls.map(request), [{
    method: "PATCH",
    path: `/session/${SESSION}/update-status/`,
    query: {},
    body: { new_status: "Resubmitted", nodes_to_resubmit, send_email: true, email_address: "a@b.co", email_preview_token: "r" },
  }]);
});

test("sharing names the application the token is for", async (t) => {
  const calls = backend(t);
  await call("didit_session_share", { session_id: SESSION, for_application_id: "app-2", ttl_in_seconds: 600 });
  assert.deepEqual(calls.map(request), [
    { method: "POST", path: `/session/${SESSION}/share/`, query: {}, body: { for_application_id: "app-2", ttl_in_seconds: 600 } },
  ]);
});

test("importing a shared session authenticates as the application", async (t) => {
  const calls = backend(t, ({ path }) => (path.startsWith(AUTH) ? { client_secret: "application-key" } : {}));
  await call("didit_session_import_shared", { share_token: "jwt", trust_review: false, workflow_id: "wf", vendor_data: "u1" });
  assert.deepEqual(request(calls.at(-1)), {
    method: "POST",
    path: "/session/import-shared/",
    query: {},
    body: { share_token: "jwt", trust_review: false, workflow_id: "wf", vendor_data: "u1" },
  });
  assert.equal(calls.at(-1).headers["x-api-key"], "application-key");
  assert.equal(calls.at(-1).headers.Authorization, undefined);
});

test("an import can be undone, only when confirmed, and can ask for a higher limit", async (t) => {
  const calls = backend(t);
  await assert.rejects(call("didit_session_manage_import", { import_id: "i1", action: "undo" }), refusal({ code: "unsafe_operation", field: "confirm" }));
  await call("didit_session_manage_import", { import_id: "i1", action: "undo", confirm: true });
  await call("didit_session_manage_import", { import_id: "i1", action: "request_limit", data: { note: "Backlog" } });
  assert.deepEqual(calls.map(request), [
    { method: "POST", path: "/session/imports/i1/undo/", query: {}, body: {} },
    { method: "POST", path: "/session/imports/i1/request-limit/", query: {}, body: { note: "Backlog" } },
  ]);
  assert.equal(calls[0].headers["X-Didit-Application-Id"], APP);
});

test("the import jobs are listed for the application", async (t) => {
  const calls = backend(t, () => ({ results: [], counts: {} }));
  await call("didit_session_import_list", { scope: "sessions", limit: 10 });
  assert.deepEqual(calls.map(request), [{ method: "GET", path: "/import-jobs/", query: { scope: "sessions", limit: "10" }, body: undefined }]);
  assert.equal(calls[0].headers["X-Didit-Organization-Id"], ORG);

  t.mock.restoreAll();
  backend(t, () => ({ status: 403, body: { detail: "You do not have permission to perform this action." } }));
  await assert.rejects(call("didit_session_import_list", {}), refusal({ status: 403 }));
});
