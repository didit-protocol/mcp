import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { DiditError } from "../dist/security.js";
import { REPORT_TOOLS, exportReport } from "../dist/tools/reports.js";

const CTX = { accessToken: "token-1", organizationId: "org-1", applicationId: "app-1" };
const inApp = (fn) => requestContext.run(CTX, fn);

// The real backend's validate_columns() raises this exact DRF shape — a field-keyed
// object whose value is a bare array containing one string.
function stubInvalidColumnsResponse(invalidColumns) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ columns: [`Invalid columns: ${invalidColumns.join(", ")}`] }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
}

test("exportReport attaches the valid session columns to an Invalid columns error", async () => {
  stubInvalidColumnsResponse(["number", "date", "status", "vendorData", "total_price"]);
  await assert.rejects(
    () => inApp(() => exportReport("sessions", { columns: ["number", "date", "status", "vendorData", "total_price"] })),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.field, "columns");
      assert.ok(Array.isArray(error.shape.allowed) && error.shape.allowed.length > 0);
      assert.ok(error.shape.allowed.includes("session_number"));
      assert.ok(error.shape.allowed.includes("vendor_data"));
      assert.ok(error.shape.allowed.includes("total_cost"));
      assert.ok(error.shape.hint.includes('kind="sessions"'));
      return true;
    },
  );
});

test("exportReport attaches the valid vendor-user columns to an Invalid columns error", async () => {
  stubInvalidColumnsResponse(["number"]);
  await assert.rejects(
    () => inApp(() => exportReport("vendor-users", { columns: ["number"] })),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.ok(error.shape.allowed.includes("didit_internal_id"));
      assert.ok(!error.shape.allowed.includes("session_number"));
      return true;
    },
  );
});

test("exportReport attaches the valid vendor-business columns to an Invalid columns error", async () => {
  stubInvalidColumnsResponse(["number"]);
  await assert.rejects(
    () => inApp(() => exportReport("vendor-businesses", { columns: ["number"] })),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.ok(error.shape.allowed.includes("legal_name"));
      return true;
    },
  );
});

test("exportReport leaves errors untouched for kinds with no known column schema (transactions/businesses)", async () => {
  stubInvalidColumnsResponse(["number"]);
  await assert.rejects(
    () => inApp(() => exportReport("transactions", { columns: ["number"] })),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.allowed, undefined);
      return true;
    },
  );
});

test("exportReport passes through a successful call unmodified", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ uuid: "report-1", status: "PENDING" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  const result = await inApp(() => exportReport("sessions", { columns: ["session_id"], export_all: true }));
  assert.equal(result.uuid, "report-1");
});

// service-didit-verification applications/urls.py, reports/…: every export the API creates.
test("every export kind of the API is offered, and its body goes as it is", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ method: init.method, path: new URL(String(url)).pathname, body: JSON.parse(init.body) });
    return Response.json({ uuid: "report-1", status: "PENDING" }, { status: 201 });
  });
  const tool = REPORT_TOOLS.find(({ def }) => def.name === "didit_report_export");
  assert.deepEqual(tool.def.inputSchema.properties.kind.enum, [
    "sessions", "transactions", "businesses", "vendor-users", "vendor-businesses", "cases", "cases-sla", "events", "compliance",
  ]);
  for (const kind of tool.def.inputSchema.properties.kind.enum) await inApp(() => tool.run({ kind, data: { notify_on_ready: true } }));
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), tool.def.inputSchema.properties.kind.enum.map((kind) => ["POST", `/v3/organization/org-1/application/app-1/reports/${kind}/`]));
  assert.deepEqual(calls[0].body, { notify_on_ready: true });
});

test("the columns a rejected export answers with are the API's current ones", async () => {
  const expected = {
    sessions: ["biometric_consent_status", "biometric_consent_ip_state"],
    "vendor-users": ["last_activity_at", "latest_verification", "risk", "open_alerts", "aml_monitoring_enabled"],
    "vendor-businesses": ["latest_kyb", "risk", "owners_verified", "industry"],
    events: ["time", "event_type", "environment"],
  };
  for (const [kind, columns] of Object.entries(expected)) {
    stubInvalidColumnsResponse(["number"]);
    await assert.rejects(() => inApp(() => exportReport(kind, { columns: ["number"] })), (error) => {
      assert.deepEqual(columns.filter((column) => !error.shape.allowed?.includes(column)), [], kind);
      return true;
    });
  }
});

test("a report is run again, over another period when one is sent; its refusal is the API's", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ method: init.method, path: new URL(String(url)).pathname, body: JSON.parse(init.body) });
    return calls.length === 1 ? Response.json({ uuid: "report-2" }, { status: 201 }) : Response.json({ detail: "It needs: read:sessions." }, { status: 403 });
  });
  const tool = REPORT_TOOLS.find(({ def }) => def.name === "didit_report_resend");
  assert.equal(tool.access, "write");
  const retried = await inApp(() => tool.run({ report_id: "report-1", date_from: "2026-11-01", date_to: "2026-11-20" }));
  assert.equal(retried.uuid, "report-2");
  assert.deepEqual(calls, [{ method: "POST", path: "/v3/organization/org-1/application/app-1/reports/report-1/retry/", body: { date_from: "2026-11-01", date_to: "2026-11-20" } }]);
  await assert.rejects(() => inApp(() => tool.run({ report_id: "report-1" })), (error) => error.shape.status === 403);
});
