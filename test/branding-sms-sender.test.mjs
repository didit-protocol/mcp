import { test } from "node:test";
import assert from "node:assert/strict";
import { updateCustomization } from "../dist/tools/customization.js";
import { requestContext } from "../dist/config.js";

// the app-level SMS sender name is set through didit_branding_update, which PATCHes
// the white-label customization the console's Phone Verification settings also write.

const WHITE_LABEL = "https://verification.didit.me/v3/organization/org-1/application/app-1/white-label-customization/";

const captureFetch = () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    return new Response(JSON.stringify({ sms_sender_name: "Acme Bank" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
};

const inApp = (fn) => requestContext.run({ accessToken: "tok", organizationId: "org-1", applicationId: "app-1" }, fn);

test("didit_branding_update sets the SMS sender name without any image", async () => {
  const calls = captureFetch();

  const result = await inApp(() => updateCustomization({ sms_sender_name: "Acme Bank" }));

  assert.equal(result.sms_sender_name, "Acme Bank");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WHITE_LABEL);
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].body.get("sms_sender_name"), "Acme Bank");
  assert.equal(calls[0].body.get("image_square"), null);
});

test("didit_branding_update clears the SMS sender name with null", async () => {
  const calls = captureFetch();

  await inApp(() => updateCustomization({ sms_sender_name: null }));

  assert.equal(calls[0].body.get("sms_sender_name"), "");
});

test("didit_branding_update still refuses a call with nothing to update", async () => {
  captureFetch();

  await assert.rejects(inApp(() => updateCustomization({})), /requires at least one image .* or sms_sender_name/);
});
