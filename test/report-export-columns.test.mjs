import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { DiditError } from "../dist/security.js";
import { exportReport } from "../dist/tools/reports.js";

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
