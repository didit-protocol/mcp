import { apiRequest, buildFormData, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { DOCUMENT_TYPES } from "./shared-schema";
import { ORG_APP_PROPS } from "../orgapp";
import { applicationApiKeyHeaders } from "../app-api-key";
import { assertSafeWebhookUrl, requireFileSource } from "../security";
import type { FileSource } from "../security";

// Standalone verification APIs via the console's user-Bearer proxy:
// /organization/{org}/application/{app}/apis/<check>/  (mirrors the console "manual checks"
// feature). This lets these run with the user's OAuth Bearer + role permissions — no
// app api-key. org/app resolve from the tool args via the request context (orgAppPath).
// The phone OTP pair is the one exception: see the note above phoneSend.
//
// Every image input is a FileSource: a local absolute *_path (stdio/local runs) or
// inline *_base64 content (hosted runs — e.g. Didit Copilot chat attachments).

export async function idVerification(
  frontImage: FileSource,
  backImage: FileSource | undefined,
  options: Record<string, any> = {},
): Promise<any> {
  const form = buildFormData(
    { front_image: requireFileSource(frontImage, "front_image"), back_image: backImage },
    options,
  );
  return apiRequest(orgAppPath("/apis/id-verification/"), { method: "POST", form });
}

export async function poaVerification(
  documentImage: FileSource,
  options: Record<string, any> = {},
): Promise<any> {
  const form = buildFormData({ document: requireFileSource(documentImage, "document_image") }, options);
  return apiRequest(orgAppPath("/apis/poa/"), { method: "POST", form });
}

/**
 * `POST /bank/account-check/` is a public product API: only an application x-api-key is accepted, and the
 * console proxy has no route for it, so it reads the key like the phone OTP pair (see app-api-key.ts).
 */
export async function accountCheck(data: Record<string, any>): Promise<any> {
  return apiRequest("/bank/account-check/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

export async function databaseValidation(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/database-validation/"), { method: "POST", json: data });
}

export async function passiveLiveness(image: FileSource, options: Record<string, any> = {}): Promise<any> {
  const form = buildFormData({ user_image: requireFileSource(image, "image") }, options);
  return apiRequest(orgAppPath("/apis/passive-liveness/"), { method: "POST", form });
}

export async function faceMatch(
  image1: FileSource,
  image2: FileSource,
  options: Record<string, any> = {},
): Promise<any> {
  const form = buildFormData(
    {
      user_image: requireFileSource(image1, "image_1"),
      ref_image: requireFileSource(image2, "image_2"),
    },
    options,
  );
  return apiRequest(orgAppPath("/apis/face-match/"), { method: "POST", form });
}

export async function faceSearch(image: FileSource, options: Record<string, any> = {}): Promise<any> {
  const form = buildFormData({ user_image: requireFileSource(image, "image") }, options);
  return apiRequest(orgAppPath("/apis/face-search/"), { method: "POST", form });
}

export async function ageEstimation(image: FileSource, options: Record<string, any> = {}): Promise<any> {
  const form = buildFormData({ user_image: requireFileSource(image, "image") }, options);
  return apiRequest(orgAppPath("/apis/age-estimation/"), { method: "POST", form });
}

export async function amlScreening(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/aml/"), { method: "POST", json: data });
}

export async function kybSearch(data: Record<string, any>): Promise<any> {
  const json = { ...data };
  // The backend calls webhook_url when a registry result resolves — SSRF-guard it.
  if (typeof json.webhook_url === "string") json.webhook_url = assertSafeWebhookUrl(json.webhook_url, "webhook_url");
  return apiRequest(orgAppPath("/apis/kyb/search/"), { method: "POST", json });
}

export async function kybSelect(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/kyb/select/"), { method: "POST", json: data });
}

export async function emailSend(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/email/send/"), { method: "POST", json: data });
}

export async function emailCheck(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/email/check/"), { method: "POST", json: data });
}

// Phone OTP is the exception to the proxy rule above: the console registers no
// …/apis/phone/send/ or …/apis/phone/check/ proxy (both 404), so these two call the
// public product APIs directly - {DIDIT_API_BASE_URL}/phone/send/ and /phone/check/
// (service-didit-verification apis/urls.py:24-25, mounted under the /v2/ and /v3/
// API-key prefixes by core/urls.py:127,178). Those views accept an application
// x-api-key and refuse a user Bearer; app-api-key.ts resolves the key and explains why.
export async function phoneSend(data: Record<string, any>): Promise<any> {
  return apiRequest("/phone/send/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

export async function phoneCheck(data: Record<string, any>): Promise<any> {
  return apiRequest("/phone/check/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

// ── The identity and document check tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const STANDALONE_DOCUMENT_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_verify_id",
      description: "Verify an identity document by submitting front (and optionally back) images. Returns structured OCR data and authenticity checks. Each image is a local absolute *_path (local/stdio runs) or inline *_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          front_image_path: { type: "string", description: "Absolute path to front image file (local/stdio only)" },
          back_image_path: { type: "string", description: "Absolute path to back image file (optional; local/stdio only)" },
          front_image_base64: { type: "string", description: "Front image as base64 or data URL (or an attachment reference like att_1)" },
          back_image_base64: { type: "string", description: "Back image as base64 or data URL (optional; or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
          perform_document_liveness: { type: "boolean", description: "Run document-presence (anti-screenshot) checks" },
          minimum_age: { type: "number", description: "Decline if the extracted age is below this value" },
          preferred_characters: { type: "string", enum: ["latin", "non_latin"], description: "Preferred OCR script" },
        },
      },
    },
    access: "write",
    permission: "create:sessions",
    run: ({ front_image_path, back_image_path, front_image_base64, back_image_base64, ...options }) =>
      idVerification(
        { path: front_image_path, base64: front_image_base64 },
        back_image_path || back_image_base64 ? { path: back_image_path, base64: back_image_base64 } : undefined,
        options,
      ),
  },
  {
    def: {
      name: "didit_verify_poa",
      description: "Proof of Address verification. Submit a single document image to extract and validate address information. The image is a local absolute *_path (local/stdio runs) or inline *_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          document_image_path: { type: "string", description: "Absolute path to the POA document image (local/stdio only)" },
          document_image_base64: { type: "string", description: "POA document image as base64 or data URL (or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
          expected_address: { type: "string", description: "Address to validate the document against" },
          expected_country: { type: "string", description: "ISO 3166-1 alpha-2 country code to validate against" },
          expected_first_name: { type: "string" },
          expected_last_name: { type: "string" },
        },
      },
    },
    access: "write",
    permission: "create:sessions",
    run: ({ document_image_path, document_image_base64, ...options }) =>
      poaVerification({ path: document_image_path, base64: document_image_base64 }, options),
  },
  {
    def: {
      name: "didit_verify_account_check",
      description:
        "Check that a bank account belongs to the person or company you name, before sending money to it. No session: send the name and the account, read the result. " +
        "result is match, close_match, no_match or cannot_verify; on a close_match, holder_name is the name the bank holds the account under (when returned); account " +
        "comes back masked to its last 4 characters. Billed once per check the bank answers at the account's country price, whatever the result (no_match and " +
        "cannot_verify too); an error is never billed. Every call is a NEW billed check (no idempotency key, no read-back): do not retry blindly and store the response. " +
        "Errors: 400 names the field and reason (consent required: in countries whose check needs the account holder's explicit consent, ask for it and send " +
        "consent:true; nothing is billed); 402 top up; 404 country_not_covered or bank_not_covered; 503 the bank could not answer, send again later. " +
        "Where Bank Verification is not switched on (production at the moment) it answers 404 bank_verification_not_available. A sandbox application calls no bank " +
        "and charges nothing: the last 4 characters of the IBAN, else the account number, choose the answer (0001 close_match with holder_name, 0002 close_match " +
        "without, 0003 and 0006 no_match, 0004 cannot_verify, 0005 a 503, 0009 a 400, anything else match).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          country: { type: "string", description: "REQUIRED. The account's country, ISO 3166-1 alpha-3 (for example GBR, NGA)." },
          account: {
            type: "object",
            description:
              "REQUIRED. The account the way its country writes it: an iban, or an account_number with the bank or branch code the country needs (sort_code, routing_number, " +
              "transit_institution, bsb, ifsc, bank_code, bic). Mexico takes a clabe and Argentina a cbu_cvu. A business account adds registration_id where the country asks. " +
              "Spaces, dashes and dots are ignored; a key the country needs and does not get is a 400 that names it.",
            properties: {
              iban: { type: "string" }, account_number: { type: "string" }, sort_code: { type: "string" }, routing_number: { type: "string" },
              transit_institution: { type: "string" }, bsb: { type: "string" }, ifsc: { type: "string" }, bank_code: { type: "string" },
              bic: { type: "string" }, clabe: { type: "string" }, cbu_cvu: { type: "string" }, registration_id: { type: "string" },
            },
          },
          holder: {
            type: "object",
            description: "REQUIRED. The name to check: full_name for a person, or business_name for a company (a business name checks a business account).",
            properties: { full_name: { type: "string" }, business_name: { type: "string" } },
          },
          vendor_data: { type: "string", description: "Your own reference for this check, returned unchanged." },
          consent: { type: "boolean", description: "true when the account holder explicitly consented to this check. Required where the country's check needs it; only set it after the user states the holder consented." },
        },
        required: ["country", "account", "holder"],
      },
    },
    // The routing ids route the call; they are not part of the check.
    access: "write",
    permission: "create:sessions", // POST /bank/account-check/ (api-key) after the same application read as the phone pair
    run: ({ organization_id: _org, application_id: _app, ...body }) => accountCheck(body),
  },
  {
    def: {
      name: "didit_verify_database",
      description: "Validate identity data against national and global authoritative data sources. issuing_state (ISO 3166-1 alpha-3) is required and selects which sources run.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          issuing_state: { type: "string", description: "REQUIRED. ISO 3166-1 alpha-3 country code that selects the data sources to query" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          middle_name: { type: "string" },
          full_name: { type: "string" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD" },
          document_number: { type: "string" },
          document_type: { type: "string", enum: DOCUMENT_TYPES },
          personal_number: { type: "string" },
          tax_number: { type: "string" },
          gender: { type: "string", enum: ["M", "F", "X"] },
          nationality: { type: "string" },
          services: { type: "array", items: { type: "string" }, description: "Optional service_ids to restrict which sources run" },
          partial_match_action: { type: "string", enum: ["DECLINE", "NO_ACTION"] },
          no_match_action: { type: "string", enum: ["DECLINE", "NO_ACTION"] },
          vendor_data: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["issuing_state"],
      },
    },
    access: "write",
    permission: "create:sessions",
    run: (args) => databaseValidation(args),
  },
];

// ── The company registry check tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const STANDALONE_KYB_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_verify_kyb_search",
      description: "Search official company registries for a business by name and/or registration number. Returns candidate matches; pass a candidate's kyb_response_id to didit_verify_kyb_select to pull the full record.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          country_code: { type: "string", description: "REQUIRED. ISO 3166-1 alpha-2 country code" },
          name: { type: "string", description: "Company name to search" },
          registration_number: { type: "string", description: "Registration number to search" },
          search_type: { type: "string", enum: ["contains", "start_with", "fuzzy"], description: "Name match strategy" },
          vendor_data: { type: "string" },
          metadata: { type: "object" },
          webhook_url: { type: "string", description: "Optional URL notified when the registry result resolves" },
        },
        required: ["country_code"],
      },
    },
    access: "write",
    permission: "create:sessions",
    run: (args) => kybSearch(args),
  },
  {
    def: {
      name: "didit_verify_kyb_select",
      description: "Resolve a candidate from didit_verify_kyb_search into a full company registry record. kyb_response_id is the per-search candidate handle returned by the search. A resolved record carries registry_status and verification_status (verified, failed or unknown).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          kyb_response_id: { type: "string", description: "REQUIRED. Candidate handle from didit_verify_kyb_search" },
          vendor_data: { type: "string" },
          metadata: { type: "object" },
          save_api_request: { type: "boolean" },
        },
        required: ["kyb_response_id"],
      },
    },
    access: "write",
    permission: "create:sessions",
    run: (args) => kybSelect(args),
  },
];

// ── The biometric check tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const STANDALONE_BIOMETRIC_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_verify_passive_liveness",
      description: "Passive liveness detection -- verify a person is physically present from a single image (no interaction required). The image is a local absolute image_path (local/stdio runs) or inline image_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_path: { type: "string", description: "Absolute path to facial image file (local/stdio only)" },
          image_base64: { type: "string", description: "Facial image as base64 or data URL (or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
      },
    },
    access: "write",
    permission: "create:sessions",
    run: ({ image_path, image_base64, ...options }) => passiveLiveness({ path: image_path, base64: image_base64 }, options),
  },
  {
    def: {
      name: "didit_verify_face_match",
      description: "Compare two facial images to determine if they belong to the same person (1:1 face matching). The score is symmetric, so image order does not affect the result. Each image is a local absolute *_path (local/stdio runs) or inline *_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_1_path: { type: "string", description: "Absolute path to the first facial image, e.g. the selfie (local/stdio only)" },
          image_2_path: { type: "string", description: "Absolute path to the second facial image, e.g. the ID portrait (local/stdio only)" },
          image_1_base64: { type: "string", description: "First facial image as base64 or data URL (or an attachment reference like att_1)" },
          image_2_base64: { type: "string", description: "Second facial image as base64 or data URL (or an attachment reference like att_2)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
      },
    },
    access: "write",
    permission: "create:sessions",
    run: ({ image_1_path, image_2_path, image_1_base64, image_2_base64, ...options }) =>
      faceMatch({ path: image_1_path, base64: image_1_base64 }, { path: image_2_path, base64: image_2_base64 }, options),
  },
  {
    def: {
      name: "didit_verify_face_search",
      description: "Search for a face against a database of previously verified faces (1:N face matching). The image is a local absolute image_path (local/stdio runs) or inline image_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_path: { type: "string", description: "Absolute path to facial image file (local/stdio only)" },
          image_base64: { type: "string", description: "Facial image as base64 or data URL (or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
      },
    },
    access: "write",
    permission: "create:sessions",
    run: ({ image_path, image_base64, ...options }) => faceSearch({ path: image_path, base64: image_base64 }, options),
  },
  {
    def: {
      name: "didit_verify_age",
      description: "Estimate a person's age from a facial image. Also performs passive liveness check. The image is a local absolute image_path (local/stdio runs) or inline image_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_path: { type: "string", description: "Absolute path to facial image file (local/stdio only)" },
          image_base64: { type: "string", description: "Facial image as base64 or data URL (or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
      },
    },
    access: "write",
    permission: "create:sessions",
    run: ({ image_path, image_base64, ...options }) => ageEstimation({ path: image_path, base64: image_base64 }, options),
  },
];

// ── The AML screening tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const STANDALONE_AML_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_verify_aml",
      description: "AML screening against global watchlists, PEP lists, sanctions, and (optionally) adverse media. Supports person and company entity types.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          full_name: { type: "string", description: "REQUIRED. Full name to screen" },
          entity_type: { type: "string", enum: ["person", "company"], description: "Defaults to person" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD (improves match accuracy)" },
          nationality: { type: "string", description: "ISO country code (improves match accuracy)" },
          document_number: { type: "string" },
          include_adverse_media: { type: "boolean", description: "Include adverse-media findings" },
          include_ongoing_monitoring: { type: "boolean", description: "Enroll the entity for ongoing monitoring" },
          vendor_data: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["full_name"],
      },
    },
    access: "write",
    permission: "create:sessions",
    run: (args) => amlScreening(args),
  },
];

// ── The email and phone check tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const STANDALONE_CONTACT_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_verify_email_send",
      description: "Send a one-time verification code to an email address. Code valid for 5 minutes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          email: { type: "string", description: "Email address to verify" },
        },
        required: ["email"],
      },
    },
    // Sends a code to the email address given.
    access: "write",
    openWorld: true,
    permission: null, // …/apis/email/send/ — route does not exist as coded
    run: (args) => emailSend(args),
  },
  {
    def: {
      name: "didit_verify_email_check",
      description: "Verify the OTP code sent to an email. Max 3 attempts per code.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          email: { type: "string" },
          code: { type: "string", description: "Verification code from email" },
        },
        required: ["email", "code"],
      },
    },
    access: "write",
    permission: null, // …/apis/email/check/ — route does not exist as coded (only /apis/email-risk/)
    run: (args) => emailCheck(args),
  },
  {
    def: {
      name: "didit_verify_phone_send",
      description:
        "Send a one-time verification code to a phone number. Delivered on WhatsApp by default, falling back to SMS where WhatsApp cannot reach that country or number. The code is valid for 5 minutes. Returns request_id plus status: Success (a new code was sent), Retry (resent while an earlier code for that number is still pending) or Blocked (the number was refused; see reason). Paid from the organization's balance, so a live application really delivers a message, and answers 403 until the organization's first top-up or when the balance is short; a sandbox application mocks the send for free. Repeated sends to one number can answer 429 with code PHONE_RATE_LIMITED. Sends with the application's API key, so the caller's role needs create:sessions (Owner, Admin or Developer; an organization owner or admin with a local didit_account_login token), and an MCP sign-in needs the didit:management scope to read that key.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          phone_number: { type: "string", description: "Phone number with country code (e.g. +1234567890)" },
        },
        required: ["phone_number"],
      },
    },
    // Sends a code to the phone number given, on WhatsApp or by SMS.
    access: "write",
    openWorld: true,
    permission: "create:sessions", // POST /phone/send/ (api-key) after the same application read
    run: (args) => phoneSend(args),
  },
  {
    def: {
      name: "didit_verify_phone_check",
      description:
        "Check the one-time code sent to a phone number and return what Didit knows about that number. Maximum 3 attempts per code, and the code expires 5 minutes after it was sent. Returns status Approved, Failed (with the attempts remaining), Declined, or 'Expired or Not Found' when that number has no code pending. A sandbox application mocks the check and approves any code. Sends with the application's API key, so the caller's role needs create:sessions (Owner, Admin or Developer; an organization owner or admin with a local didit_account_login token), and an MCP sign-in needs the didit:management scope to read that key.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          phone_number: { type: "string" },
          code: { type: "string", description: "Verification code from the WhatsApp or SMS message" },
        },
        required: ["phone_number", "code"],
      },
    },
    access: "write",
    permission: "create:sessions", // POST /phone/check/ (api-key) after GET auth /organizations/{org}/applications/{app} → serializers/applications.py:100 blanks the key without it
    run: (args) => phoneCheck(args),
  },
];
