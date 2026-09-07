import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseErrorBody, sanitizeText, assertSafeWebhookUrl, pathSegment,
  redactApplication, assertBoolean, DiditError, maskSecret,
} from "../dist/security.js";
import { stripRoutingIds } from "../dist/config.js";
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

test("sanitizeText: preserves didit_* tool names but redacts didit-shaped secrets", () => {
  const s = sanitizeText("Call didit_context_get first; never share didit_A8f3kQ92xZ or didit-4b84a26ae44f");
  assert.match(s, /didit_context_get/); // tool name survives (error hints reference tools)
  assert.doesNotMatch(s, /didit_A8f3kQ92xZ/); // mixed-case/digit tail → secret-shaped → redacted
  assert.doesNotMatch(s, /didit-4b84a26ae44f/); // hyphen separator is never a tool name → redacted
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

// A value that never arrived must not be reported as a malformed value. The old
// wording told a caller that had sent a clean UUID that it "must be a string ... with no
// path separators" - a hint describing a condition its input already met - so the real
// fault (the id was dropped upstream) stayed invisible across 10 production traces.
const rejection = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DiditError, `expected a DiditError, got ${err}`);
    return err.shape;
  }
  assert.fail("expected pathSegment to throw");
};

test("pathSegment: a missing value reads as missing, not as a bad string", () => {
  for (const missing of [undefined, null]) {
    const shape = rejection(() => pathSegment(missing, "organization_id"));
    assert.match(shape.message, /organization_id is required but no value was received/);
    assert.equal(shape.field, "organization_id");
    // The old, misleading wording must not resurface for a value that was never sent.
    assert.doesNotMatch(shape.message, /must be a string/);
    assert.doesNotMatch(shape.hint ?? "", /path separators/);
  }
});

test("pathSegment: a wrong-typed value names the type it actually got", () => {
  assert.match(rejection(() => pathSegment(["org-1"], "organization_id")).message, /must be a string \(received an array\)/);
  assert.match(rejection(() => pathSegment({ id: "org-1" }, "organization_id")).message, /must be a string \(received an object\)/);
  assert.match(rejection(() => pathSegment(42, "organization_id")).message, /must be a string \(received a number\)/);
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

// ── Base64 uploads (hosted transport) ────────────────────────────────────────
import { validateUploadBuffer, resolveFileSource, requireFileSource } from "../dist/security.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = PNG_MAGIC.toString("base64");

test("validateUploadBuffer: accepts raw base64 and data URLs of a real image", () => {
  const raw = validateUploadBuffer(PNG_B64, "image_base64");
  assert.equal(raw.type, "png");
  assert.ok(raw.buffer.equals(PNG_MAGIC));
  const dataUrl = validateUploadBuffer(`data:image/png;base64,${PNG_B64}`, "image_base64");
  assert.equal(dataUrl.type, "png");
});

test("validateUploadBuffer: rejects empty / non-base64 / unrecognised content", () => {
  assert.throws(() => validateUploadBuffer("", "image_base64"), DiditError);
  assert.throws(() => validateUploadBuffer("not base64!!!", "image_base64"), DiditError);
  // Valid base64 of non-image bytes must fail the magic-bytes sniff.
  const text = Buffer.from("SECRET=hunter2\n").toString("base64");
  assert.throws(() => validateUploadBuffer(text, "image_base64"), DiditError);
});

test("validateUploadBuffer: rejects payloads over the upload cap before decoding", () => {
  const oversized = "A".repeat(Math.ceil((15 * 1024 * 1024 + 1024) * (4 / 3)));
  assert.throws(() => validateUploadBuffer(oversized, "image_base64"), DiditError);
});

test("resolveFileSource: base64 source yields buffer + synthesized filename", () => {
  const resolved = resolveFileSource({ base64: PNG_B64 }, "user_image");
  assert.ok(resolved.buffer.equals(PNG_MAGIC));
  assert.equal(resolved.filename, "user_image.png");
});

test("resolveFileSource: rejects both path+base64; empty optional resolves undefined", () => {
  assert.throws(() => resolveFileSource({ path: "/tmp/x.png", base64: PNG_B64 }, "image"), DiditError);
  assert.equal(resolveFileSource({}, "image"), undefined);
  assert.throws(() => resolveFileSource({}, "image", { required: true }), DiditError);
});

test("requireFileSource: throws with local-vs-hosted hint when nothing is provided", () => {
  const err = /** @type {any} */ (
    (() => { try { requireFileSource({}, "front_image"); return null; } catch (e) { return e; } })()
  );
  assert.ok(err instanceof DiditError);
  assert.match(String(err.shape?.hint || ""), /front_image_base64/);
  assert.doesNotThrow(() => requireFileSource({ base64: PNG_B64 }, "front_image"));
});

/**
 * The routing ids never reach a handler as payload: the dispatcher reads them
 * into requestContext, then strips them. Without this, advertising them on the
 * tools that forward their args verbatim (lists.listLists → query string,
 * webhooks.createDestination → POST body) would send the console API fields it
 * never asked for.
 */
test("stripRoutingIds removes only the routing ids", () => {
  assert.deepEqual(
    stripRoutingIds({ organization_id: "o", application_id: "a", list_type: "blocklist", limit: "5" }),
    { list_type: "blocklist", limit: "5" },
  );
  assert.deepEqual(stripRoutingIds({ limit: "5" }), { limit: "5" });
  assert.deepEqual(stripRoutingIds({}), {});
  assert.equal(stripRoutingIds(undefined), undefined);
});
