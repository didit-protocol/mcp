import { apiRequest, orgAppPath } from "../config";
import { pathSegment, assertBoolean, assertSafeWebhookUrl, DiditError, MAX_BATCH_IDS } from "../security";

// createSession stays on the wired developer /session/ endpoint (accepts the user Bearer via
// IsValidUserOrgClient). Session LIST / bulk-delete / reviews are org/app-scoped console
// resources. Per-session detail ops (decision, update-*, generate-pdf) are FLAT /session/{id}/...
// — the console calls them flat with the user Bearer, so they are left unchanged.

const sid = (id: string) => pathSegment(id, "session_id");

export async function createSession(data: Record<string, any>): Promise<any> {
  const json = { ...data };
  // portrait_image may be a URL the backend fetches — SSRF-guard it (base64 left untouched).
  if (typeof json.portrait_image === "string" && /^https?:\/\//i.test(json.portrait_image)) {
    json.portrait_image = assertSafeWebhookUrl(json.portrait_image, "portrait_image");
  }
  return apiRequest("/session/", { method: "POST", json });
}

export async function listSessions(params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath("/sessions/"), { params });
}

export async function getSessionDecision(sessionId: string): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/decision/`);
}

export async function updateSessionStatus(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/update-status/`, { method: "PATCH", json: data });
}

export async function updateSessionData(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/update-data/`, { method: "PATCH", json: data });
}

export async function updateSessionPoaData(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/update-poa-data/`, { method: "PATCH", json: data });
}

export async function deleteSession(sessionId: string): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/delete/`, { method: "DELETE" });
}

export async function batchDeleteSessions(
  sessionNumbers?: number[],
  deleteAll?: unknown,
  confirm?: unknown,
): Promise<any> {
  assertBoolean(deleteAll, "delete_all");
  assertBoolean(confirm, "confirm");
  const wildcard = deleteAll === true;
  if (wildcard) {
    if (confirm !== true) {
      throw new DiditError({
        code: "unsafe_operation",
        message: "delete_all permanently removes EVERY session in this application.",
        field: "confirm",
        hint: "Re-call with confirm:true to proceed, or pass an explicit session_numbers array instead.",
      });
    }
  } else if (!Array.isArray(sessionNumbers) || sessionNumbers.length === 0) {
    throw new DiditError({
      code: "bad_request",
      message: "Provide a non-empty session_numbers array, or set delete_all with confirm:true.",
      field: "session_numbers",
    });
  } else if (sessionNumbers.length > MAX_BATCH_IDS) {
    throw new DiditError({
      code: "bad_request",
      message: `Too many session_numbers (max ${MAX_BATCH_IDS} per batch).`,
      field: "session_numbers",
    });
  }
  return apiRequest(orgAppPath("/sessions/delete/"), {
    method: "DELETE",
    json: { session_numbers: sessionNumbers, delete_all: wildcard },
  });
}

export async function generateSessionPdf(sessionId: string): Promise<any> {
  // Console fetches the PDF via GET /session/{id}/generate-pdf/ (trailing slash matters —
  // a slash-less path redirects and drops the auth header → 403; flat, user Bearer).
  return apiRequest(`/session/${sid(sessionId)}/generate-pdf/`);
}

export async function listSessionReviews(sessionId: string): Promise<any> {
  return apiRequest(orgAppPath(`/sessions/${sid(sessionId)}/reviews/`));
}

export async function addSessionReview(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/sessions/${sid(sessionId)}/reviews/`), { method: "POST", json: data });
}

export async function shareSession(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/share/`, { method: "POST", json: data });
}

export async function importSharedSession(data: Record<string, any>): Promise<any> {
  return apiRequest("/session/import-shared/", { method: "POST", json: data });
}

export async function createImport(data: Record<string, any>): Promise<any> {
  const json = { ...data };
  // The backend FETCHES source_file_url — SSRF-guard it before forwarding.
  if (typeof json.source_file_url === "string") {
    json.source_file_url = assertSafeWebhookUrl(json.source_file_url, "source_file_url");
  }
  return apiRequest("/session/imports/", { method: "POST", json });
}

export async function getImportTemplate(): Promise<any> {
  return apiRequest("/session/imports/template/");
}

export async function getImport(importId: string): Promise<any> {
  return apiRequest(`/session/imports/${pathSegment(importId,"import_id")}/`);
}

export async function getImportErrors(importId: string): Promise<any> {
  return apiRequest(`/session/imports/${pathSegment(importId,"import_id")}/errors/`);
}
