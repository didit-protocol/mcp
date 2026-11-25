import { apiRequest, buildFormData, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { DOCUMENT_TYPES } from "./shared-schema";
import { ORG_APP_PROPS } from "../orgapp";
import { applicationApiKeyHeaders } from "../app-api-key";
import { DiditError, assertSafeWebhookUrl, pathSegment, requireFileSource } from "../security";
import type { FileSource } from "../security";

// Standalone verification APIs via the console's user-Bearer proxy:
// /organization/{org}/application/{app}/apis/<check>/  (mirrors the console "manual checks"
// feature). This lets these run with the user's OAuth Bearer + role permissions — no
// app api-key. org/app resolve from the tool args via the request context (orgAppPath).
// The email and phone codes are the exception: see the note above emailSend.
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

const KYB_TIERS = ["basic", "shareholders", "ubo"];

export async function documentAi(document: FileSource, options: Record<string, any>): Promise<any> {
  const form = buildFormData({ document: requireFileSource(document, "document") }, options);
  // The reader goes by the file's declared type, and a file built from bytes has none.
  const file = form.get("document") as File;
  const type = FILE_TYPES[file.name.split(".").pop()?.toLowerCase() ?? ""];
  if (type) form.set("document", new Blob([file], { type }), file.name);

  return apiRequest(orgAppPath("/apis/document-ai/"), { method: "POST", form });
}

const FILE_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", tiff: "image/tiff",
};

export async function addressValidation(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/address-validation/"), { method: "POST", json: data });
}

/** Where each kind of risk check names its value, its country and the settings it has no use for. */
const RISK_KINDS: Readonly<Record<string, { value: string; country: string; not: readonly string[] }>> = {
  phone: { value: "phone_number", country: "country_code", not: ["user_agent"] },
  email: { value: "email", country: "country_code", not: ["user_agent"] },
  ip: { value: "ip_address", country: "claimed_country", not: ["signals", "enable_social"] },
};

export async function riskCheck({ kind, value, country, ...data }: Record<string, any>): Promise<any> {
  const fields = Object.keys(RISK_KINDS).includes(kind) ? RISK_KINDS[kind] : undefined;
  if (!fields) {
    throw new DiditError({ code: "bad_request", message: "kind must be phone, email or ip.", field: "kind", allowed: Object.keys(RISK_KINDS) });
  }
  // The API ignores a field its check does not have, so an answer would look like it used it.
  const unused = fields.not.find((field) => data[field] !== undefined);
  if (unused) throw new DiditError({ code: "bad_request", message: `${unused} does not apply to a ${kind} check.`, field: unused });

  return apiRequest(orgAppPath(`/apis/${pathSegment(kind, "kind")}-risk/`), { method: "POST", json: { [fields.value]: value, [fields.country]: country, ...data } });
}

/** The plan is free and runs nothing; the check runs and bills the modules of that plan. */
export async function fraudCheck({ plan_only: planOnly = true, confirm, identifiers, attributes, ...data }: Record<string, any>): Promise<any> {
  if (planOnly === false && confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: "A fraud check bills every module it runs. Re-call with confirm:true once the person agreed to the plan's price.",
      field: "confirm",
      hint: "Call it with plan_only:true first and show estimated_price.",
    });
  }
  const path = planOnly === false ? "/apis/fraud-check/" : "/apis/fraud-check/plan/";

  return apiRequest(orgAppPath(path), { method: "POST", json: { ...data, subject: { identifiers, attributes } } });
}

/** Each registry tier is its own endpoint (and its own price). */
export async function kybSelect({ tier = "basic", ...data }: Record<string, any>): Promise<any> {
  if (!KYB_TIERS.includes(tier)) {
    throw new DiditError({ code: "bad_request", message: `tier must be one of ${KYB_TIERS.join(", ")}.`, field: "tier", allowed: KYB_TIERS });
  }
  const route = pathSegment(tier === "basic" ? "select" : tier, "tier");

  return apiRequest(orgAppPath(`/apis/kyb/${route}/`), { method: "POST", json: data });
}

// The email and phone codes are the exception to the proxy rule above: the console registers no
// …/apis/{email,phone}/{send,check}/ proxy (all four answer 404), so these call the
// public product APIs directly - {DIDIT_API_BASE_URL}/email/… and /phone/…
// (service-didit-verification apis/urls.py and urls_v3.py, under the /v3/ API-key prefix).
// Those views accept an application
// x-api-key and refuse a user Bearer; app-api-key.ts resolves the key and explains why.
export async function emailSend(data: Record<string, any>): Promise<any> {
  return apiRequest("/email/send/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

export async function emailCheck(data: Record<string, any>): Promise<any> {
  return apiRequest("/email/check/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

export async function phoneSend(data: Record<string, any>): Promise<any> {
  return apiRequest("/phone/send/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

export async function phoneCheck(data: Record<string, any>): Promise<any> {
  return apiRequest("/phone/check/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

// ── Schema pieces these tools share ─────────────────────────────────────────────────────────────

const METADATA = { type: "object" } as const;
const REQUEST_PROPS = {
  metadata: METADATA,
  save_api_request: { type: "boolean", description: "Default true" },
} as const;
const ROTATE_IMAGE = { type: "boolean", description: "Also try the image rotated" } as const;
const PERCENT = { type: "number", minimum: 0, maximum: 100 } as const;
const DEVICE_SIGNALS = {
  type: "object",
  description: "ip, device_id, device_platform (android|ios|ipados|tvos|web), device_model, os_version, app_version, user_agent",
} as const;
const CODE_CHECK_PROPS = {
  enable_enrichment: { type: "boolean", description: "Add intelligence and a risk score (billed)" },
  enable_social: { type: "boolean", description: "Add the social footprint (billed)" },
} as const;

/** The `*_action` fields of a check as one argument: each key travels flat in the request. */
function actionsProp(defaults: string, keys: readonly string[], values: readonly string[] = ["DECLINE", "NO_ACTION"]) {
  return {
    type: "object",
    description: `What each finding does (${defaults}). Keys: ${keys.join(", ")}.`,
    additionalProperties: { type: "string", enum: values },
  } as const;
}

/** `actions` carries `*_action` fields only, and never replaces an argument of the call. */
function withActions({ actions = {}, ...body }: Record<string, any>): Record<string, any> {
  const unknown = Object.keys(actions).find((key) => !key.endsWith("_action"));
  if (unknown) throw new DiditError({ code: "bad_request", message: `actions does not take ${unknown}.`, field: "actions" });

  return { ...actions, ...body };
}

/** Only the arguments a tool declares: what the API also takes and no agent may send never travels. */
function declared(args: Record<string, any>, props: Record<string, unknown>): Record<string, any> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => Object.keys(props).includes(key)));
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
          actions: actionsProp("default DECLINE; NO_ACTION for the first and the last", ["expiration_date_not_detected_action", "invalid_mrz_action", "inconsistent_data_action", "critical_field_occlusion_action", "document_or_personal_number_format_mismatch_action"]),
          ...REQUEST_PROPS,
        },
      },
    },
    access: "write",
    permission: "create:sessions",
    run: ({ front_image_path, back_image_path, front_image_base64, back_image_base64, ...options }) =>
      idVerification(
        { path: front_image_path, base64: front_image_base64 },
        back_image_path || back_image_base64 ? { path: back_image_path, base64: back_image_base64 } : undefined,
        withActions(options),
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
          poa_languages_allowed: { type: "string", description: "Comma-separated language codes, e.g. en,es" },
          poa_document_age_months: { type: "string", description: "Maximum age per type, e.g. utility_bill:3,bank_statement:6,government_issued_document:12,other_poa_document:-1 (-1 = any)" },
          actions: actionsProp("default DECLINE", ["poa_name_mismatch_action", "poa_document_issues_action", "poa_document_authenticity_action", "poa_unsupported_language_action", "poa_address_mismatch_action", "poa_issuer_not_identified_action"]),
          ...REQUEST_PROPS,
        },
      },
    },
    access: "write",
    permission: "create:sessions",
    run: ({ document_image_path, document_image_base64, ...options }) =>
      poaVerification({ path: document_image_path, base64: document_image_base64 }, withActions(options)),
  },
  {
    def: {
      name: "didit_verify_account_check",
      description:
        "Check that a bank account belongs to the person or company you name, before sending money to it. No session: send the name and the account, read the result. " +
        "result is match, close_match, no_match or cannot_verify; on a close_match, holder_name is the name the bank holds the account under (when returned); account " +
        "comes back masked to its last 4 characters. Billed once per check the bank answers at the account's country price, whatever the result (no_match and " +
        "cannot_verify too); an error is never billed. This tool sends no Idempotency-Key, so every call is a NEW billed check (and no endpoint reads a check back): do not retry blindly and store the response. " +
        "Errors: 400 names the field and reason (consent required: in countries whose check needs the account holder's explicit consent, ask for it and send " +
        "consent:true; nothing is billed); 402 top up; 404 country_not_covered or bank_not_covered; 503 the bank could not answer, send again later. " +
        "When Bank Verification is not available for the application it answers 404 bank_verification_not_available. A sandbox application calls no bank " +
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
          identification_number: { type: "string", description: "The person's number; mapped to the field the country uses" },
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
          expiration_date: { type: "string", description: "YYYY-MM-DD" },
          date_of_issue: { type: "string", description: "YYYY-MM-DD" },
          address: { type: "object", description: "street_1, street_2, city, region, postal_code, country" },
          consent: { type: "boolean", description: "true only when the person explicitly consented; required by services whose catalog entry has requires_consent" },
          extra_fields: { type: "object", description: "Other fields the country's services ask for, sent as they are (e.g. ssn, pan, bvn, phone, email, postal_code)" },
          services: { type: "array", items: { type: "string" }, description: "Optional service_ids to restrict which sources run" },
          partial_match_action: { type: "string", enum: ["DECLINE", "NO_ACTION"] },
          no_match_action: { type: "string", enum: ["DECLINE", "NO_ACTION"] },
          vendor_data: { type: "string" },
          ...REQUEST_PROPS,
        },
        required: ["issuing_state"],
      },
    },
    access: "write",
    permission: "create:sessions",
    run: ({ extra_fields, ...body }) => databaseValidation({ ...extra_fields, ...body }),
  },
];

const DOCUMENT_AI_PROPS = {
  document_path: { type: "string", description: "PDF or image, absolute path (local/stdio only)" },
  document_base64: { type: "string", description: "Base64, data URL or an attachment reference like att_1" },
  fields: {
    type: "array",
    items: {
      type: "object",
      properties: {
        key: { type: "string", description: "Lowercase letters, digits and _" },
        name: { type: "string" },
        instruction: { type: "string" },
        type: { type: "string", enum: ["text", "number", "date"] },
        required: { type: "boolean" },
        is_full_name: { type: "boolean" },
      },
      required: ["key"],
    },
    description: "REQUIRED. What to extract, 1 to 30 fields",
  },
  expected_first_name: { type: "string" },
  expected_last_name: { type: "string" },
  expected_company_name: { type: "string", description: "Instead of a person's name" },
  expected_company_country: { type: "string", description: "Alpha-2" },
  document_ai_name_match_score_threshold: { ...PERCENT, description: "Default 80" },
  actions: actionsProp(
    "default REVIEW; tampering DECLINE, name mismatch NO_ACTION",
    ["document_ai_unreadable_document_action", "document_ai_missing_required_fields_action", "document_ai_document_tampering_action", "document_ai_name_mismatch_action", "document_ai_unsupported_file_action"],
    ["DECLINE", "REVIEW", "NO_ACTION"],
  ),
  vendor_data: { type: "string" },
  ...REQUEST_PROPS,
} as const;

// ── The checks of an address, a document's contents and fraud signals (tools/registry.ts) ──────────
export const STANDALONE_INTELLIGENCE_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_verify_document_ai",
      description: "Extract the fields you name from any document (contract, invoice, deed…) and check its authenticity and names. Billed per document.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, ...DOCUMENT_AI_PROPS }, required: ["fields"] },
    },
    access: "write",
    permission: "create:sessions", // POST …/apis/document-ai/ → applications/views/proxy.py DocumentAIProxyAPIView
    run: ({ document_path, document_base64, fields, ...options }) =>
      documentAi({ path: document_path, base64: document_base64 }, { ...withActions(options), fields }),
  },
  {
    def: {
      name: "didit_verify_address",
      description: "Check that a postal address exists and get it normalised with its coordinates. It never links the address to a person. status: verified, partially_verified, not_verified or unavailable. Billed per answer except unavailable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          address: { type: "string", description: "The whole address on one line, or the parts below" },
          address_line_1: { type: "string" },
          address_line_2: { type: "string" },
          city: { type: "string" },
          region: { type: "string" },
          postal_code: { type: "string" },
          country: { type: "string", description: "REQUIRED. ISO 3166-1 alpha-2 or alpha-3" },
        },
        required: ["country"],
      },
    },
    access: "write",
    permission: "create:sessions", // POST …/apis/address-validation/ → AddressValidationProxyAPIView
    run: (args) => addressValidation(args),
  },
  {
    def: {
      name: "didit_verify_risk",
      description: "Risk score and intelligence of a phone number, an email address or an IP, without contacting anyone. Billed per answer.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          kind: { type: "string", enum: ["phone", "email", "ip"] },
          value: { type: "string", description: "E.164 number, email address or IP" },
          country: { type: "string", description: "Country hint; for an IP, the country the person claims (a mismatch is flagged)" },
          enable_social: { type: "boolean", description: "phone, email: add the social footprint (billed)" },
          signals: { ...DEVICE_SIGNALS, description: `phone, email: ${DEVICE_SIGNALS.description}` },
          user_agent: { type: "string", description: "ip only" },
          vendor_data: { type: "string" },
          metadata: METADATA,
        },
        required: ["kind", "value"],
      },
    },
    access: "write",
    permission: "create:sessions", // POST …/apis/{phone,email,ip}-risk/ → PhoneRisk, EmailRisk and IPRiskProxyAPIView
    run: (args) => riskCheck(args),
  },
  {
    def: {
      name: "didit_verify_fraud_check",
      description: "Fraud recommendation from one or more identifiers of a person. By default it only plans: which modules would run and their price, free. plan_only:false runs and bills them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          identifiers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["email", "phone", "national_id", "tax_number", "passport_number", "driving_licence_number", "residence_permit_number", "voter_id", "external_id"] },
                value: { type: "string" },
                country: { type: "string", description: "Required for government identifiers" },
                issuer: { type: "string" },
              },
              required: ["type", "value"],
            },
          },
          attributes: { type: "object", description: "first_name, last_name, full_name, date_of_birth, nationality, gender, address, city, state, postal_code" },
          context: { type: "object", description: "ip_address, user_agent, country, purpose, consent_obtained" },
          checks: { type: "object", description: "include or exclude: lists of module names from the plan" },
          client_reference: { type: "string", description: "Your reference; reusing it never bills the same check twice" },
          vendor_data: { type: "string" },
          metadata: METADATA,
          plan_only: { type: "boolean", description: "Default true" },
          confirm: { type: "boolean", description: "Must be true with plan_only:false - it is billed. Only set after explicit user confirmation of this exact action." },
        },
      },
    },
    access: "write",
    permission: "create:sessions", // POST …/apis/fraud-check/plan/ and …/apis/fraud-check/ → FraudCheckPlanProxyAPIView, FraudCheckProxyAPIView
    run: (args) => fraudCheck(args),
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
          country_code: { type: "string", description: "REQUIRED. ISO 3166-1 alpha-2 country code; the US needs a state (US-CA)" },
          name: { type: "string", description: "Company name to search" },
          registration_number: { type: "string", description: "Registration number to search" },
          search_type: { type: "string", enum: ["contains"] },
          tier: { type: "string", enum: KYB_TIERS, description: "The depth you will select. Default basic" },
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
      description: "Resolve a candidate from didit_verify_kyb_search into a full company registry record. kyb_response_id is the per-search candidate handle returned by the search. A resolved record carries registry_status and verification_status (verified, failed or unknown). Billed at the country's price of the tier delivered (registry_tier_delivered).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          kyb_response_id: { type: "string", description: "REQUIRED. Candidate handle from didit_verify_kyb_search" },
          tier: { type: "string", enum: KYB_TIERS, description: "basic (default): company and officers; shareholders and ubo cost more" },
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
          face_liveness_score_decline_threshold: PERCENT,
          rotate_image: ROTATE_IMAGE,
          ...REQUEST_PROPS,
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
          face_match_score_decline_threshold: PERCENT,
          rotate_image: ROTATE_IMAGE,
          ...REQUEST_PROPS,
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
          search_type: { type: "string", enum: ["most_similar", "blocklisted_or_approved"], description: "Default most_similar" },
          rotate_image: ROTATE_IMAGE,
          ...REQUEST_PROPS,
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
          age_estimation_decline_threshold: { ...PERCENT, description: "Decline below this age. Default 18" },
          face_liveness_score_decline_threshold: PERCENT,
          rotate_image: ROTATE_IMAGE,
          ...REQUEST_PROPS,
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
          include_ongoing_monitoring: { type: "boolean", description: "Enroll the entity for ongoing monitoring (needs a saved request)" },
          aml_match_score_threshold: { ...PERCENT, description: "Hits below it are false positives. Default 93" },
          aml_score_approve_threshold: { ...PERCENT, description: "Approved below it. Default 86" },
          aml_score_review_threshold: { ...PERCENT, description: "Declined above it, In Review in between. Default 100" },
          aml_name_weight: { ...PERCENT, description: "The three weights sum 100. Defaults 60, 25, 15" },
          aml_dob_weight: PERCENT,
          aml_country_weight: PERCENT,
          sandbox_scenario: { type: "string", description: "Sandbox only: scenario slug, e.g. decline_aml_hit, review_aml_possible_match" },
          vendor_data: { type: "string" },
          ...REQUEST_PROPS,
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
const CODE_KEY_NOTE =
  "Sends with the application's API key, so the caller's role needs create:sessions (Owner, Admin or Developer; an organization owner or admin with a local didit_account_login token), and an MCP sign-in needs the didit:management scope to read that key.";

/** The same for the email tools, whose note points at the phone one. */
const CODE_KEY_REFERENCE = "Uses the application's API key, like didit_verify_phone_send.";

const PHONE_SEND_PROPS = {
  phone_number: { type: "string", description: "Phone number with country code (e.g. +1234567890)" },
  options: {
    type: "object",
    properties: {
      locale: { type: "string", description: "e.g. en-US" },
      preferred_channel: { type: "string", enum: ["sms", "whatsapp", "telegram", "voice", "rcs", "viber", "zalo"] },
      use_white_label_customization: { type: "boolean" },
      sms_sender_name: { type: "string", description: "Name that signs this SMS; default the application's" },
    },
  },
  channels: { type: "array", items: { type: "string" }, description: "Order of silent, sms, whatsapp, telegram, voice, rcs, viber, zalo, email, push, totp, passkey" },
  allowed_channels: { type: "array", items: { type: "string" }, description: "Only these channels" },
  force_challenge: { type: "boolean", description: "Only fraud-resistant channels" },
  on_conflict: {
    type: "string",
    enum: ["replace", "reuse", "retry", "reject"],
    description: "While a code is valid: replace (default) sends a new one, reuse sends nothing, retry sends it again, reject answers 409 verification_in_progress",
  },
  code_length: { type: "integer", minimum: 4, maximum: 10 },
  signals: DEVICE_SIGNALS,
  vendor_data: { type: "string" },
  metadata: METADATA,
} as const;

const PHONE_CHECK_PROPS = {
  phone_number: { type: "string", description: "Or verification_id" },
  verification_id: { type: "string", description: "From didit_verify_phone_send" },
  code: { type: "string", description: "Verification code from the WhatsApp or SMS message" },
  actions: actionsProp("default NO_ACTION", ["duplicated_phone_number_action", "disposable_number_action", "voip_number_action", "phone_intelligence_score_action", "phone_type_risk_action", "recent_port_action", "low_phone_trust_action", "phone_no_social_presence_action"]),
  ...CODE_CHECK_PROPS,
} as const;

export const STANDALONE_CONTACT_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_verify_email_send",
      description: `Send a one-time verification code to an email address. Valid for 5 minutes. Billed per first delivered send; a sandbox application sends nothing. ${CODE_KEY_REFERENCE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          email: { type: "string", description: "Email address to verify" },
          options: {
            type: "object",
            properties: {
              code_size: { type: "integer", minimum: 4, maximum: 8 },
              alphanumeric_code: { type: "boolean" },
              locale: { type: "string", description: "e.g. en" },
              use_white_label_customization: { type: "boolean" },
            },
          },
          signals: DEVICE_SIGNALS,
          vendor_data: { type: "string" },
          metadata: METADATA,
        },
        required: ["email"],
      },
    },
    // Sends a code to the email address given.
    access: "write",
    openWorld: true,
    permission: "create:sessions", // POST /email/send/ (api-key) after the same application read as the phone pair
    run: (args) => emailSend(args),
  },
  {
    def: {
      name: "didit_verify_email_check",
      description: `Verify the code sent to an email address. Maximum 3 attempts per code. Returns status Approved, Failed, Declined or 'Expired or Not Found', and what Didit knows about the address. ${CODE_KEY_REFERENCE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          email: { type: "string" },
          code: { type: "string", description: "Verification code from email" },
          actions: actionsProp("default NO_ACTION", ["duplicated_email_action", "breached_email_action", "disposable_email_action", "email_intelligence_score_action", "recent_email_breach_action", "frequent_email_breach_action", "email_no_social_presence_action"]),
          ...CODE_CHECK_PROPS,
        },
        required: ["email", "code"],
      },
    },
    access: "write",
    permission: "create:sessions", // POST /email/check/ (api-key) after the same application read
    run: (args) => emailCheck(withActions(args)),
  },
  {
    def: {
      name: "didit_verify_phone_send",
      description:
        `Send a one-time verification code to a phone number. Delivered on WhatsApp by default, falling back to SMS where WhatsApp cannot reach that country or number. The code lives the application's setting (1 to 15 minutes; expires_in in the answer). Returns request_id, verification_id and status: Success (a new code was sent), Retry (sent again while an earlier code for that number is still pending) or Blocked (the number was refused; see reason). Paid from the organization's balance, so a live application really delivers a message, and answers 403 until the organization's first top-up or when the balance is short; a sandbox application delivers nothing, for free. Repeated sends to one number can answer 429 with code PHONE_RATE_LIMITED. ${CODE_KEY_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, ...PHONE_SEND_PROPS },
        required: ["phone_number"],
      },
    },
    // Sends a code to the phone number given, on WhatsApp or by SMS.
    access: "write",
    openWorld: true,
    permission: "create:sessions", // POST /phone/send/ (api-key) after the same application read
    run: (args) => phoneSend(declared(args, PHONE_SEND_PROPS)),
  },
  {
    def: {
      name: "didit_verify_phone_check",
      description:
        `Check the one-time code sent to a phone number and return what Didit knows about that number. The attempts per code (3 to 10) and its lifetime are the application's settings. Returns status Approved, Failed (with the attempts remaining), Declined, or 'Expired or Not Found' when that number has no code pending. A sandbox application accepts code 123456. ${CODE_KEY_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, ...PHONE_CHECK_PROPS },
        required: ["code"],
      },
    },
    access: "write",
    permission: "create:sessions", // POST /phone/check/ (api-key) after GET auth /organizations/{org}/applications/{app} → serializers/applications.py:100 blanks the key without it
    run: (args) => phoneCheck(withActions(declared(args, PHONE_CHECK_PROPS))),
  },
];
