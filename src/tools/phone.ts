import { apiRequest } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { applicationApiKeyHeaders } from "../app-api-key";

// The Phone API's reads that stand on their own. Like the phone codes (standalone.ts) they are public
// product APIs that take the application's API key (service-didit-verification apis/urls_v3.py).

export async function validatePhone(data: Record<string, any>): Promise<any> {
  return apiRequest("/phone/validate/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

// ── The phone tools (tools/registry.ts) ──────────────────────────────────
export const PHONE_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_phone_validate",
      description: "Check that a phone number is well formed and get it in E.164 and national format, with its country. Free; contacts nobody. Uses the application's API key, like didit_verify_phone_send.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          phone_number: { type: "string", description: "International (+34600000012), or national with country" },
          country: { type: "string", description: "ISO 3166-1 alpha-2, for a national number" },
        },
        required: ["phone_number"],
      },
    },
    access: "read",
    permission: "create:sessions", // POST /phone/validate/ (api-key) after the same application read as the phone codes
    run: ({ phone_number, country }) => validatePhone({ phone_number, country }),
  },
];
