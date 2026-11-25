import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { EVENT_TOOLS } from "../dist/tools/events.js";
import { MONITORING_TOOLS } from "../dist/tools/monitoring.js";
import { toolGroupOf, toolsetOf } from "../dist/toolsets.js";

// The monitoring events of the client API (/v3/events/…, sessions/urls_v3.py) and the AML ongoing
// monitoring switch of the console (vendor-users|vendor-businesses/toggle-ongoing-monitoring/).

delete process.env.DIDIT_ACCESS_TOKEN;

const API = "https://verification.didit.me/v3";
const EVENT = "4c3b2a19-8f7e-4d6c-9b5a-0e1f2a3b4c5d";
const JOB = "5d4c3b2a-9e8f-4d6c-8b5a-1e1f2a3b4c5d";
const TOOLS = new Map([...EVENT_TOOLS, ...MONITORING_TOOLS].map((tool) => [tool.def.name, tool]));

function recordFetch(t, reply = () => ({ count: 0, results: [] })) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const parsed = new URL(String(url));
    const sent = { method: init.method ?? "GET", path: `${parsed.origin}${parsed.pathname}`, query: Object.fromEntries(parsed.searchParams), body: init.body && JSON.parse(init.body), headers: init.headers };
    calls.push(sent);
    const answer = reply(sent);
    return answer instanceof Response ? answer : Response.json(answer);
  });
  return calls;
}

const call = async (name, args) =>
  requestContext.run({ accessToken: "token-1", organizationId: "org-1", applicationId: "app-1" }, () => TOOLS.get(name).run(args));
const sent = ({ method, path, query, body }) => ({ method, path, query, body });

test("events are listed and read with the application's scope headers", async (t) => {
  const calls = recordFetch(t);
  const filters = { event_category: "auth", status: "IN_REVIEW", subject_vendor_data: "user-1", matched_only: true, occurred_from: "2026-11-01T00:00:00Z", limit: 5 };
  await call("didit_event_list", filters);
  await call("didit_event_get", { event_id: EVENT });
  await call("didit_event_subject_get", { vendor_data: "ana@example.com", entity_type: "company", event_category: "payment", offset: 50 });
  assert.deepEqual(calls.map(sent), [
    { method: "GET", path: `${API}/events/`, query: { ...filters, matched_only: "true", limit: "5" }, body: undefined },
    { method: "GET", path: `${API}/events/${EVENT}/`, query: {}, body: undefined },
    { method: "GET", path: `${API}/events/subjects/ana%40example.com/`, query: { entity_type: "company", event_category: "payment", offset: "50" }, body: undefined },
  ]);
  for (const { headers } of calls) {
    assert.equal(headers.Authorization, "Bearer token-1");
    assert.deepEqual([headers["X-Didit-Organization-Id"], headers["X-Didit-Application-Id"]], ["org-1", "app-1"]);
  }
  for (const tool of EVENT_TOOLS) assert.deepEqual([tool.access, tool.permission, toolsetOf(tool.def.name), toolGroupOf(tool.def.name)], ["read", ["read:transactions", "list:transactions"], "transactions", "Transactions (AML)"]);
});

test("an event's device session is not a verification session: no event tool takes session_id", async (t) => {
  const calls = recordFetch(t);
  await call("didit_event_list", { device_session_id: "web-1" });
  assert.deepEqual(calls[0].query, { session_id: "web-1" });
  for (const tool of EVENT_TOOLS) assert.ok(!("session_id" in tool.def.inputSchema.properties), tool.def.name);
});

test("an event refusal is the API's own, and an id cannot leave its route", async (t) => {
  recordFetch(t, () => Response.json({ detail: "You do not have permission to perform this action." }, { status: 403 }));
  await assert.rejects(call("didit_event_list", {}), (error) => error.shape.status === 403);
  await assert.rejects(call("didit_event_get", { event_id: "../transactions" }), (error) => error.shape.field === "event_id");
});

const ID = "6e5d4c3b-0f9e-4d6c-8b5a-2e1f2a3b4c5d";
const APP_BASE = `${API}/organization/org-1/application/app-1`;

test("ongoing monitoring is only estimated unless the call says otherwise: the API's own default runs it", async (t) => {
  const calls = recordFetch(t, () => ({ estimate: { billable: 2, balance_sufficient: true } }));
  await call("didit_monitoring_update", { target: "vendor_users", is_enabled: true, didit_internal_ids: [ID] });
  await call("didit_monitoring_update", { target: "vendor_businesses", is_enabled: true, update_all: true, filters: { status: ["ACTIVE"] } });
  assert.deepEqual(calls.map(sent), [
    { method: "PATCH", path: `${APP_BASE}/vendor-users/toggle-ongoing-monitoring/`, query: {}, body: { is_enabled: true, estimate_only: true, didit_internal_id_list: [ID] } },
    { method: "PATCH", path: `${APP_BASE}/vendor-businesses/toggle-ongoing-monitoring/`, query: {}, body: { filter_status: ["ACTIVE"], is_enabled: true, estimate_only: true, update_all: true } },
  ]);
});

test("the billed run needs confirm, and its job is read by the same target", async (t) => {
  const calls = recordFetch(t, () => ({ job_id: JOB, status: "PENDING" }));
  const run = { target: "vendor_users", is_enabled: true, didit_internal_ids: [ID], estimate_only: false };
  for (const confirm of [undefined, "true"]) {
    await assert.rejects(call("didit_monitoring_update", { ...run, confirm }), (error) => error.shape.code === "unsafe_operation" && error.shape.field === "confirm");
  }
  await assert.rejects(call("didit_monitoring_update", { ...run, target: "sessions", confirm: true }), (error) => error.shape.field === "target");
  assert.equal(calls.length, 0);

  await call("didit_monitoring_update", { ...run, confirm: true });
  await call("didit_monitoring_get", { target: "vendor_businesses", job_id: JOB });
  assert.deepEqual(calls.map(sent), [
    { method: "PATCH", path: `${APP_BASE}/vendor-users/toggle-ongoing-monitoring/`, query: {}, body: { is_enabled: true, estimate_only: false, didit_internal_id_list: [ID] } },
    { method: "GET", path: `${APP_BASE}/vendor-businesses/toggle-ongoing-monitoring/${JOB}/`, query: {}, body: undefined },
  ]);

  const update = TOOLS.get("didit_monitoring_update");
  assert.deepEqual([update.access, update.permission, toolsetOf("didit_monitoring_update")], ["destructive", "write:sessions", "vendors"]);
  assert.match(update.def.inputSchema.properties.confirm.description, /explicit user confirmation of this exact action/);
  assert.deepEqual(TOOLS.get("didit_monitoring_get").permission, ["read:sessions", "list:sessions"]);
});
