import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseErrorBody, sanitizeText, assertSafeWebhookUrl, pathSegment,
  redactApplication, assertBoolean, DiditError, maskSecret,
} from "../dist/security.js";
import { topUp } from "../dist/tools/billing.js";
import { manageCase } from "../dist/tools/cases.js";
import { batchDeleteSessions } from "../dist/tools/sessions.js";

const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

test("parseErrorBody: field-keyed bad enum", () => {
  const r = parseErrorBody({ entry_type: ['"document_number" is not a valid choice.'] });
  assert.equal(r.field, "entry_type");
  assert.match(r.message, /not a valid choice/);
});
test("parseErrorBody: nested array (workflow features)", () => {
  const r = parseErrorBody({ features: [["Each workflow feature must be an object."]] });
  assert.equal(r.field, "features");
  assert.match(r.message, /must be an object/);
});
test("parseErrorBody: nested object (questionnaire element_type)", () => {
  const r = parseErrorBody({ form_elements: [{ element_type: ["This field is required."] }] });
  assert.equal(r.field, "form_elements");
  assert.match(r.message, /required/);
});
test("parseErrorBody: bare array (no field)", () => {
  const r = parseErrorBody(["Provide vendor_data_list or set delete_all=true."]);
  assert.equal(r.field, undefined);
  assert.match(r.message, /Provide vendor_data_list/);
});
test("parseErrorBody: standard {detail}", () => {
  const r = parseErrorBody({ detail: "Not found." });
  assert.equal(r.message, "Not found.");
});

test("sanitizeText: redacts secrets, preserves canonical UUID", () => {
  const s = sanitizeText("key sk_live_ABCDEF123456 and id 4b84a26a-e44f-4024-bc11-a175fddeb509 ok");
  assert.match(s, /redacted/);
  assert.match(s, /4b84a26a-e44f-4024-bc11-a175fddeb509/); // UUID preserved
  assert.doesNotMatch(s, /sk_live_ABCDEF123456/);
});

test("assertSafeWebhookUrl: blocks internal targets", () => {
  for (const u of ["http://localhost/x", "http://169.254.169.254/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.5/", "http://127.0.0.1.nip.io/"]) {
    assert.throws(() => assertSafeWebhookUrl(u, "url"), DiditError, u);
  }
  assert.equal(assertSafeWebhookUrl("https://example.com/hook", "url"), "https://example.com/hook");
});

test("pathSegment: rejects traversal, allows in-segment dots", () => {
  assert.throws(() => pathSegment("../billing/balance", "x"), DiditError);
  assert.throws(() => pathSegment("a/b", "x"), DiditError);
  assert.throws(() => pathSegment("..", "x"), DiditError);
  assert.equal(pathSegment("customer..prod", "x"), "customer..prod");
});

test("redactApplication: drops api_key, sets flag + preview", () => {
  const r = redactApplication({ uuid: "1", name: "App", api_key: "RRkN4VuX-secret-key-1234" });
  assert.equal(r.api_key, undefined);
  assert.equal(r.api_key_set, true);
  assert.ok(r.api_key_preview);
});

test("assertBoolean: rejects truthy 'false' string", () => {
  assert.throws(() => assertBoolean("false", "confirm"), DiditError);
  assert.doesNotThrow(() => assertBoolean(true, "confirm"));
  assert.doesNotThrow(() => assertBoolean(undefined, "confirm"));
});

test("top_up: rejects NaN / <50 / unconfirmed", async () => {
  assert.ok(await threw(() => topUp(NaN, true)));
  assert.ok(await threw(() => topUp(40, true)));
  assert.ok(await threw(() => topUp(100, undefined)));     // no confirm
  assert.ok(await threw(() => topUp(100, "true")));        // string confirm rejected
});

test("manage_case: rejects unknown action + SAR without confirm", async () => {
  assert.ok(await threw(() => manageCase("c1", "frobnicate", {})));            // unknown action
  assert.ok(await threw(() => manageCase("c1", "sar", {})));                   // SAR no confirm
  assert.ok(await threw(() => manageCase("c1", "resolve", { status: "SAR_FILED" }))); // smuggled SAR
});

test("batch_delete_sessions: rejects delete_all:'false' + wildcard without confirm", async () => {
  assert.ok(await threw(() => batchDeleteSessions(undefined, "false")));   // truthy-string bypass
  assert.ok(await threw(() => batchDeleteSessions(undefined, true)));      // wildcard no confirm
  assert.ok(await threw(() => batchDeleteSessions([], false)));            // empty + no wildcard
});

test("maskSecret: never returns the raw value", () => {
  assert.doesNotMatch(maskSecret("supersecretvalue123") || "", /supersecretvalue123/);
});
