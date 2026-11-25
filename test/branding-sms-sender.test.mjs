import { test } from "node:test";
import assert from "node:assert/strict";
import { getCustomization, updateCustomization } from "../dist/tools/customization.js";
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
  assert.deepEqual(JSON.parse(calls[0].body), { sms_sender_name: "Acme Bank" });
});

test("didit_branding_update clears the SMS sender name with null", async () => {
  const calls = captureFetch();

  await inApp(() => updateCustomization({ sms_sender_name: null }));

  assert.deepEqual(JSON.parse(calls[0].body), { sms_sender_name: "" });
});

test("didit_branding_update still refuses a call with nothing to update", async () => {
  captureFetch();

  await assert.rejects(inApp(() => updateCustomization({})), /requires at least one image .* or sms_sender_name/);
});

test("didit_branding_update sends the settings as the PATCH fields the API takes", async () => {
  const calls = captureFetch();

  await inApp(() =>
    updateCustomization({
      colors: { primary: "#2567FF", button_text_1: "#fff" },
      border_radius_panel: 8,
      skip_welcome_screen: false,
      sms_templates: { es: "{code} es tu codigo" },
      delete_images: ["rectangular_dark", "favicon"],
      domain: "kyc.acme.test",
      from_email: "kyc@acme.test",
      verify_domain: true,
    }),
  );

  assert.deepEqual(JSON.parse(calls[0].body), {
    color_primary: "#2567FF",
    color_button_text_1: "#fff",
    border_radius_panel: 8,
    skip_welcome_screen: false,
    sms_templates: { es: "{code} es tu codigo" },
    delete_logo_rectangular_dark: true,
    delete_favicon: true,
  });
});

test("didit_branding_update sends settings next to an image in the form, objects as JSON text", async () => {
  const calls = captureFetch();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  await inApp(() => updateCustomization({ image_rectangular_dark_base64: png, copy_overrides: { en: { title: "Hi" } }, callback_seconds: 5 }));

  assert.ok(calls[0].body.get("image_rectangular_dark"));
  assert.equal(calls[0].body.get("copy_overrides"), '{"en":{"title":"Hi"}}');
  assert.equal(calls[0].body.get("callback_seconds"), "5");
});

test("didit_branding_update refuses a color or image the API would ignore", async () => {
  const calls = captureFetch();

  await assert.rejects(inApp(() => updateCustomization({ colors: { accent: "#fff" } })), /colors has no 'accent'/);
  await assert.rejects(inApp(() => updateCustomization({ delete_images: ["banner"] })), /delete_images has no 'banner'/);
  assert.equal(calls.length, 0);
});

test("didit_branding_get adds the email senders only when asked", async () => {
  const calls = captureFetch();

  assert.equal("email_senders" in (await inApp(() => getCustomization())), false);
  const result = await inApp(() => getCustomization(true));

  assert.deepEqual(result.email_senders, { sms_sender_name: "Acme Bank" });
  assert.deepEqual(calls.map((call) => call.url), [WHITE_LABEL, WHITE_LABEL, `${WHITE_LABEL}email-senders/`]);
});

test("didit_branding_update resets the own SMS sender with null, which survives the blank-argument cleanup", async () => {
  const { dropBlankOptionals } = await import("../dist/blank-args.js");
  const { REGISTERED_TOOLS } = await import("../dist/tools/registered.js");
  const calls = captureFetch();
  const args = dropBlankOptionals({ sms_sender_id: null }, REGISTERED_TOOLS.get("didit_branding_update").def.inputSchema);

  await inApp(() => updateCustomization(args));

  assert.deepEqual(JSON.parse(calls[0].body), { sms_sender_id: "" });
});
