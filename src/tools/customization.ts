import { apiRequest, buildFormData, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";

// White-label branding — the console resource is `white-label-customization`, org/app-scoped.

export async function getCustomization(): Promise<any> {
  return apiRequest(orgAppPath("/white-label-customization/"));
}

/**
 * Update branding: logo images and/or the SMS sender name. Accepts the tool's *_path
 * (local/stdio) or *_base64 (hosted) image inputs and maps them to the API's multipart field
 * names. `sms_sender_name` is the app-level name every SMS verification code carries (free);
 * an empty string clears it. Throws if nothing was supplied so the caller gets a clear local
 * error instead of an empty PATCH.
 */
export async function updateCustomization(inputs: {
  image_square_path?: string;
  image_rectangular_path?: string;
  image_favicon_path?: string;
  image_square_base64?: string;
  image_rectangular_base64?: string;
  image_favicon_base64?: string;
  sms_sender_name?: string | null;
}): Promise<any> {
  const files = {
    image_square: { path: inputs.image_square_path, base64: inputs.image_square_base64 },
    image_rectangular: { path: inputs.image_rectangular_path, base64: inputs.image_rectangular_base64 },
    image_favicon: { path: inputs.image_favicon_path, base64: inputs.image_favicon_base64 },
  };
  const hasImage = Object.values(files).some((f) => f.path || f.base64);
  // null and "" both clear the name; the API treats a blank value as "no sender name".
  const hasSenderName = inputs.sms_sender_name !== undefined;
  if (!hasImage && !hasSenderName) {
    throw new Error(
      "updateCustomization requires at least one image (square, rectangular, or favicon) as *_path or *_base64, or sms_sender_name.",
    );
  }
  const scalars = hasSenderName ? { sms_sender_name: inputs.sms_sender_name ?? "" } : {};
  return apiRequest(orgAppPath("/white-label-customization/"), {
    method: "PATCH",
    form: buildFormData(files, scalars),
  });
}

// ── The branding tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const BRANDING_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_branding_get",
      description: "Get the current branding customization (logos, colors) applied to your verification UI.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    access: "read",
    permission: ["read:customization", "list:customization"], // GET …/white-label-customization/ → white_label_customization.py:66
    run: () => getCustomization(),
  },
  {
    def: {
      name: "didit_branding_update",
      description: "Update verification UI branding images and/or the SMS sender name. Each image is a local absolute *_path (local/stdio runs) or inline *_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_square_path: { type: "string", description: "Absolute path to a square logo image (local/stdio only)" },
          image_rectangular_path: { type: "string", description: "Absolute path to a rectangular logo image (local/stdio only)" },
          image_favicon_path: { type: "string", description: "Absolute path to a favicon image (local/stdio only)" },
          image_square_base64: { type: "string", description: "Square logo as base64 or data URL (or an attachment reference like att_1)" },
          image_rectangular_base64: { type: "string", description: "Rectangular logo as base64 or data URL (or an attachment reference like att_1)" },
          image_favicon_base64: { type: "string", description: "Favicon as base64 or data URL (or an attachment reference like att_1)" },
          sms_sender_name: {
            type: ["string", "null"],
            maxLength: 30,
            description:
              "The name every SMS verification code of this application carries (\"123456 is your verification code for Acme Bank\"), in every workflow and through the phone verification API. Free. 1 to 30 characters: letters, digits, spaces and ' & - ! only, not only digits, single spaces between words. Empty string or null clears it. WhatsApp codes are not branded.",
          },
        },
      },
    },
    access: "write",
    permission: "write:customization", // PATCH …/white-label-customization/ → white_label_customization.py:73
    run: (args) => updateCustomization(args),
  },
];
