import { apiRequest, orgAppPath } from "../config";
import { DiditError } from "../security";

// Async export reports — org/app-scoped console resource.

// The `columns` schema the backend enforces per export `kind` (400 "Invalid columns" on
// a miss) — mirrored from service-didit-verification's src/applications/serializers/csv.py
// (BASE/PHONE/KYC/POA_COLUMNS for sessions, VENDOR_USER_EXPORT_COLUMNS,
// VENDOR_BUSINESS_EXPORT_COLUMNS). `transactions` and `businesses` are NOT listed here —
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
];
const VENDOR_USER_EXPORT_COLUMNS = [
  "didit_internal_id", "vendor_data", "display_name", "full_name", "date_of_birth", "status", "session_count",
  "approved_count", "declined_count", "in_review_count", "last_session_at", "first_session_at", "created_at",
  "updated_at", "tags", "approved_emails", "approved_phones", "issuing_states", "id_document_types",
  "id_document_countries", "poa_document_types", "poa_document_countries", "payment_method_types",
  "payment_method_account_ids", "payment_method_countries", "payment_method_owner_names", "location_countries",
  "location_cities", "device_brands", "device_models", "platforms", "has_vpn_or_tor", "has_datacenter",
  "metadata", "email", "phone_number", "address_line_1", "address_line_2", "address_city", "address_state",
  "address_country", "address_zip_code",
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
];
const KNOWN_COLUMN_SCHEMAS: Record<string, string[]> = {
  sessions: SESSION_EXPORT_COLUMNS,
  "vendor-users": VENDOR_USER_EXPORT_COLUMNS,
  "vendor-businesses": VENDOR_BUSINESS_EXPORT_COLUMNS,
};

export async function listReports(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/reports/"), { params });
}

export async function getReport(reportId: string): Promise<any> {
  return apiRequest(orgAppPath(`/reports/${reportId}/`));
}

export async function getReportDownloadUrl(reportId: string): Promise<any> {
  return apiRequest(orgAppPath(`/reports/${reportId}/download-url/`));
}

// kind ∈ sessions | transactions | businesses | vendor-users | vendor-businesses
export async function exportReport(kind: string, data: Record<string, any> = {}): Promise<any> {
  try {
    return await apiRequest(orgAppPath(`/reports/${kind}/`), { method: "POST", json: data });
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
