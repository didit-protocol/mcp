import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { PAGE_PROPS, pageParams } from "../paging";
import { ORG_APP_PROPS } from "../orgapp";
import { DiditError, pathSegment } from "../security";

// Async export reports — org/app-scoped console resource.

// The `columns` schema the backend enforces per export `kind` (400 "Invalid columns" on
// a miss) — mirrored from service-didit-verification's src/applications/serializers/csv.py
// (BASE/PHONE/KYC/POA/BIOMETRIC_CONSENT_COLUMNS for sessions, VENDOR_USER_EXPORT_COLUMNS,
// VENDOR_BUSINESS_EXPORT_COLUMNS) and services/report_generators.py (EVENT_EXPORT_COLUMNS). `transactions` and `businesses` are NOT listed here —
// their views accept any column string (unknown ones just render blank), so there's no
// finite schema to validate against.
const SESSION_EXPORT_COLUMNS = [
  "session_id", "session_number", "vendor_data", "session_status", "original_status", "tags",
  "ip_location_country", "workflow_type", "ip_address", "device_brand", "device_model", "platform",
  "browser", "is_vpn_or_tor", "is_datacenter", "liveness_status", "face_match_status", "face_match_score",
  "aml_status", "aml_matches_count", "aml_monitoring_enabled", "created_at", "warnings", "email", "total_cost",
  "mobile_country_code", "mobile",
  "full_name", "first_name", "middle_name", "last_name", "document_type", "issuing_state", "nationality",
  "document_number", "personal_number", "date_of_birth", "expiration_date", "date_of_issue", "gender",
  "address_line_1", "address_line_2", "address_city", "address_state", "address_country", "address_zip_code",
  "poa_name_on_document", "poa_issuing_state", "poa_document_type", "poa_document_language", "poa_issuer",
  "poa_issue_date", "poa_address_line_1", "poa_address_line_2", "poa_address_city", "poa_address_state",
  "poa_address_country", "poa_address_zip_code",
  "biometric_consent_required", "biometric_consent_trigger", "biometric_consent_status", "biometric_consent_at",
  "biometric_consent_text_version", "biometric_consent_ip_address", "biometric_consent_ip_country", "biometric_consent_ip_state",
];
const VENDOR_USER_EXPORT_COLUMNS = [
  "didit_internal_id", "vendor_data", "display_name", "full_name", "date_of_birth", "status", "session_count",
  "approved_count", "declined_count", "in_review_count", "last_session_at", "first_session_at", "last_activity_at",
  "created_at", "updated_at", "tags", "approved_emails", "approved_phones", "issuing_states", "id_document_types",
  "id_document_countries", "poa_document_types", "poa_document_countries", "payment_method_types",
  "payment_method_account_ids", "payment_method_countries", "payment_method_owner_names", "location_countries",
  "location_cities", "device_brands", "device_models", "platforms", "has_vpn_or_tor", "has_datacenter",
  "metadata", "email", "phone_number", "address_line_1", "address_line_2", "address_city", "address_state",
  "address_country", "address_zip_code", "latest_verification", "risk", "open_alerts", "aml_monitoring_enabled",
];
const VENDOR_BUSINESS_EXPORT_COLUMNS = [
  "didit_internal_id", "vendor_data", "display_name", "legal_name", "registration_number", "country_code",
  "status", "session_count", "approved_count", "declined_count", "in_review_count", "last_session_at",
  "first_session_at", "last_activity_at", "created_at", "updated_at", "tags", "metadata", "email",
  "phone_number", "address_line_1", "address_line_2", "address_city", "address_state", "address_country",
  "address_zip_code",
  "latest_session_id", "latest_workflow_type", "company_type", "incorporation_date", "jurisdiction",
  "registry_status", "verification_status", "tax_number", "risk_level", "is_from_registry", "registered_address",
  "kyb_status", "kyb_registry_status", "kyb_documents_status", "kyb_key_people_status", "officers_count",
  "officers_names", "officers_designations", "officers_nationalities", "beneficial_owners_count",
  "beneficial_owners_names", "beneficial_owners_emails", "beneficial_owners_nationalities",
  "beneficial_owners_ownership_shares", "aml_status", "aml_matches_count", "aml_risk_level",
  "aml_last_screened", "aml_monitoring_enabled", "documents_count", "documents_verified_count",
  "documents_pending_count", "documents_declined_count", "documents_types",
  "latest_kyb", "risk", "owners_verified", "industry",
];
const EVENT_EXPORT_COLUMNS = [
  "time", "event", "event_type", "subject", "vendor_data", "source", "severity", "outcome", "ip_address", "country",
  "device", "record", "application", "environment",
];
const KNOWN_COLUMN_SCHEMAS: Record<string, string[]> = {
  sessions: SESSION_EXPORT_COLUMNS,
  "vendor-users": VENDOR_USER_EXPORT_COLUMNS,
  "vendor-businesses": VENDOR_BUSINESS_EXPORT_COLUMNS,
  events: EVENT_EXPORT_COLUMNS,
};
const EXPORT_KINDS = ["sessions", "transactions", "businesses", "vendor-users", "vendor-businesses", "cases", "cases-sla", "events", "compliance"];

export async function listReports(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/reports/"), { params });
}

export async function getReport(reportId: string): Promise<any> {
  return apiRequest(orgAppPath(`/reports/${pathSegment(reportId, "report_id")}/`));
}

export async function getReportDownloadUrl(reportId: string): Promise<any> {
  return apiRequest(orgAppPath(`/reports/${pathSegment(reportId, "report_id")}/download-url/`));
}

export async function retryReport(reportId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/reports/${pathSegment(reportId, "report_id")}/retry/`), { method: "POST", json: data });
}

export async function exportReport(kind: string, data: Record<string, any> = {}): Promise<any> {
  if (!EXPORT_KINDS.includes(kind)) {
    throw new DiditError({ code: "bad_request", message: `kind must be one of ${EXPORT_KINDS.join(", ")}.`, field: "kind", allowed: EXPORT_KINDS });
  }
  try {
    return await apiRequest(orgAppPath(`/reports/${pathSegment(kind, "kind")}/`), { method: "POST", json: data });
  } catch (error) {
    // The backend's "Invalid columns" 400 never lists what IS valid, so `sessions` /
    // `vendor-users` / `vendor-businesses` exports were undiscoverable without reading
    // the backend source. Attach the real schema so the agent can retry from the error
    // alone, the same way `allowed` already works for rejected enum values.
    const schema = KNOWN_COLUMN_SCHEMAS[kind];
    if (error instanceof DiditError && schema && error.shape.field === "columns" && !error.shape.allowed?.length) {
      throw new DiditError({
        ...error.shape,
        allowed: schema,
        hint: `Retry with only values from \`allowed\` (the valid columns for kind="${kind}"). Session KYC/phone/POA columns also accept a numbered suffix for multi-instance data, e.g. full_name_2.`,
      });
    }
    throw error;
  }
}

// ── The report tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const REPORT_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_report_list",
      description: "List the application's generated reports, newest first, with how many there are of each status (`counts`). One page: 50 unless `limit` says otherwise, with `count` as the total and `offset` to read the ones after.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          status: { type: "string", description: "Only these statuses, comma separated: PENDING, PROCESSING, READY, FAILED." },
          report_type: {
            type: "string",
            description: "Only these report types, comma separated, for example SESSION_EXPORT, TRANSACTION_EXPORT, CASE_EXPORT, VENDOR_USER_EXPORT.",
          },
          q: { type: "string", description: "Search by any part of the report id, or of the name or email of the person who asked for it." },
          ...PAGE_PROPS,
        },
      },
    },
    access: "read",
    permission: null, // GET …/reports/ → reports.py:100, same
    run: (args) => listReports({ ...args, ...pageParams(args) }),
  },
  {
    def: {
      name: "didit_report_get",
      description: "Get a report's status/details.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, report_id: { type: "string" } }, required: ["report_id"] },
    },
    access: "read",
    permission: null, // GET …/reports/{id}/ → reports.py:129, @has_privileges([]) + row-level check
    run: (args) => getReport(args.report_id),
  },
  {
    def: {
      name: "didit_report_get_download_url",
      description: "Get a signed download URL for a finished report.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, report_id: { type: "string" } }, required: ["report_id"] },
    },
    access: "read",
    permission: null, // GET …/reports/{id}/download-url/ → reports.py:153, same
    run: (args) => getReportDownloadUrl(args.report_id),
  },
  {
    def: {
      name: "didit_report_export",
      description: "Start an export report. `data.columns` is a kind-specific schema — for sessions/vendor-users/vendor-businesses an unknown column 400s with `Invalid columns`, and that error's `allowed` field carries the full valid-column list for that kind, so retry from the error alone rather than guessing names like `date`/`status`/`total_price`.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          kind: { type: "string", enum: EXPORT_KINDS },
          data: {
            type: "object",
            description:
              "The export's columns and filters. cases, cases-sla: filter_status[], filter_priority[], date_from, date_to, format CSV|PDF. events: from, to (366 days at most), columns, format CSV|JSON, and filters such as source, type, severity. " +
              "compliance: report_type (COMPLIANCE_KYC_KYB, _AML_LOG, _TRAVEL_RULE, _SANCTIONS_PEP, _RISK_SUMMARY, _SAR_STR_DRAFT, _CTR, _CASE_SUMMARY), date_from, date_to, formats [PDF|CSV|REGULATOR], jurisdiction (FINCEN, GOAML, OTHER) for SAR/CTR, case_id for SAR, case_ids for the case summary, threshold_amount and currency for CTR.",
          },
        },
        required: ["kind"],
      },
    },
    // Its name reads like a read, but it starts an export job that writes a file.
    access: "write",
    permission: null, // POST …/reports/{kind}/ — permission varies by kind (report_generators.py create_claims_for)
    run: (args) => exportReport(args.kind, args.data || {}),
  },
  {
    def: {
      name: "didit_report_resend",
      description: "Run a report again, as a new report with the same options (the original is kept). Send both dates for another period.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          report_id: { type: "string" },
          date_from: { type: "string", description: "YYYY-MM-DD" },
          date_to: { type: "string", description: "YYYY-MM-DD" },
          item_ids: { type: "array", items: { type: "string" }, description: "Only these failed sessions of your own sessions export" },
        },
        required: ["report_id"],
      },
    },
    access: "write",
    permission: null, // POST …/reports/{id}/retry/ → reports.py:461, the claims its type needs, checked per report
    run: ({ report_id, ...data }) => retryReport(report_id, data),
  },
];
