import { apiRequest, buildFormData, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { DiditError } from "../security";

// White-label branding — the console resource is `white-label-customization`, org/app-scoped.

export async function getCustomization(includeEmailSenders = false): Promise<any> {
  const branding = await apiRequest(orgAppPath("/white-label-customization/"));
  if (!includeEmailSenders) return branding;

  return { ...branding, email_senders: await apiRequest(orgAppPath("/white-label-customization/email-senders/")) };
}

const IMAGES = ["image_square", "image_rectangular", "image_rectangular_dark", "image_favicon"] as const;
const COLORS = [
  "primary", "secondary", "background", "panel", "panel_10", "on_panel_1", "on_panel_2", "on_background",
  "button_1", "button_2", "button_text_1", "button_text_2", "pill_text",
];
const DELETABLE: Readonly<Record<string, string>> = {
  square: "delete_logo_square",
  rectangular: "delete_logo_rectangular",
  rectangular_dark: "delete_logo_rectangular_dark",
  favicon: "delete_favicon",
};
// The settings sent as they are. The domain and the email senders are not changed from here.
const SETTINGS = [
  "border_radius_panel", "border_radius_buttons", "font_family", "font_weight", "app_public_name",
  "privacy_policy_url", "skip_welcome_screen", "disable_login_with_didit", "hide_progress_bar",
  "callback_seconds", "copy_overrides", "completion_display_mode", "sms_templates", "sms_sender_id",
];

/** The API ignores a field it does not know, so a misspelled one would look saved. */
function known(value: string, allowed: readonly string[], field: string): string {
  if (allowed.includes(value)) return value;
  throw new DiditError({ code: "bad_request", message: `${field} has no '${value}'.`, field, allowed: [...allowed] });
}

/** The PATCH fields of the settings a call sends (WhiteLabelCustomizationSerializer). */
function customizationFields(inputs: Record<string, any>): Record<string, unknown> {
  const colors = Object.entries(inputs.colors ?? {}).map(([key, value]) => [`color_${known(key, COLORS, "colors")}`, value]);
  const deletes = (inputs.delete_images ?? []).map((image: string) => [DELETABLE[known(image, Object.keys(DELETABLE), "delete_images")], true]);
  const settings = SETTINGS.filter((key) => inputs[key] !== undefined).map((key) => [key, inputs[key]]);

  return {
    ...Object.fromEntries([...settings, ...colors, ...deletes]),
    // null and "" both clear the name; the API treats a blank value as "no sender name".
    ...(inputs.sms_sender_name === undefined ? {} : { sms_sender_name: inputs.sms_sender_name ?? "" }),
    // null resets it: a blank string is dropped before it reaches here.
    ...(inputs.sms_sender_id === null ? { sms_sender_id: "" } : {}),
  };
}

/**
 * Update branding. Accepts the tool's *_path (local/stdio) or *_base64 (hosted) image inputs and
 * maps them to the API's multipart field names; without an image the settings travel as JSON.
 * `sms_sender_name` is the app-level name every SMS verification code carries (free);
 * an empty string clears it. Throws if nothing was supplied so the caller gets a clear local
 * error instead of an empty PATCH.
 */
export async function updateCustomization(inputs: Record<string, any>): Promise<any> {
  const files = Object.fromEntries(IMAGES.map((image) => [image, { path: inputs[`${image}_path`], base64: inputs[`${image}_base64`] }]));
  const hasImage = Object.values(files).some((f) => f.path || f.base64);
  const fields = customizationFields(inputs);
  if (!hasImage && Object.keys(fields).length === 0) {
    throw new Error("updateCustomization requires at least one image (*_path or *_base64), or a setting such as colors or sms_sender_name.");
  }
  return apiRequest(orgAppPath("/white-label-customization/"), {
    method: "PATCH",
    ...(hasImage ? { form: buildFormData(files, fields) } : { json: fields }),
  });
}

// ── The branding tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const BRANDING_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_branding_get",
      description: "Get the current branding customization (logos, colors) applied to your verification UI. Also fonts, texts, SMS sender, domain_state and what the plan includes.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, include_email_senders: { type: "boolean", description: "Add the application's own email senders and their DNS state" } },
      },
    },
    access: "read",
    permission: ["read:customization", "list:customization"], // GET …/white-label-customization/ → white_label_customization.py:66
    run: (args) => getCustomization(args.include_email_senders === true),
  },
  {
    def: {
      name: "didit_branding_update",
      description: "Update the verification UI's branding and the SMS sender: only what is sent changes. Each image is a local absolute *_path (local/stdio runs) or inline *_base64 content (hosted runs). Custom domain and email senders: in the console.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_square_path: { type: "string", description: "Absolute path to a square logo image (local/stdio only)" },
          image_rectangular_path: { type: "string", description: "Absolute path to a rectangular logo image (local/stdio only)" },
          image_rectangular_dark_path: { type: "string", description: "Dark-mode 2:1 logo (local/stdio only)" },
          image_favicon_path: { type: "string", description: "Absolute path to a favicon image (local/stdio only)" },
          image_square_base64: { type: "string", description: "Square logo as base64 or data URL (or an attachment reference like att_1)" },
          image_rectangular_base64: { type: "string", description: "Rectangular logo as base64 or data URL (or an attachment reference like att_1)" },
          image_rectangular_dark_base64: { type: "string", description: "Dark-mode 2:1 logo, base64 like the others" },
          image_favicon_base64: { type: "string", description: "Favicon as base64 or data URL (or an attachment reference like att_1)" },
          sms_sender_name: {
            type: ["string", "null"],
            maxLength: 30,
            description:
              "The name every SMS verification code of this application carries (\"123456 is your verification code for Acme Bank\"), in every workflow and through the phone verification API. Free. 1 to 30 characters: letters, digits, spaces and ' & - ! only, not only digits, single spaces between words. Empty string or null clears it. WhatsApp codes are branded only from your own WhatsApp number.",
          },
          delete_images: { type: "array", items: { type: "string", enum: Object.keys(DELETABLE) } },
          colors: { type: "object", description: `Hex colors by key: ${COLORS.join(", ")}`, additionalProperties: { type: "string" } },
          border_radius_panel: { type: "integer", description: "Pixels" },
          border_radius_buttons: { type: "integer", description: "Pixels" },
          font_family: { type: "string", description: "A Google Fonts name" },
          font_weight: { type: "string" },
          app_public_name: { type: "string" },
          privacy_policy_url: { type: "string" },
          skip_welcome_screen: { type: "boolean" },
          disable_login_with_didit: { type: "boolean" },
          hide_progress_bar: { type: "boolean" },
          callback_seconds: { type: "integer", description: "Seconds before returning to the callback" },
          completion_display_mode: { type: "string", enum: ["decision", "submitted"], description: "submitted: always the neutral 'received' screen" },
          copy_overrides: { type: "object", description: "{locale: {key: text}}; replaces the saved texts" },
          sms_templates: { type: "object", description: "{language: text with {code}, optionally {brand}}; replaces the saved texts" },
          sms_sender_id: { type: ["string", "null"], description: "Own SMS sender, 3 to 11 letters, digits or spaces; null = Didit's" },
        },
      },
    },
    access: "write",
    permission: "write:customization", // PATCH …/white-label-customization/ → white_label_customization.py:73
    run: (args) => updateCustomization(args),
  },
];
