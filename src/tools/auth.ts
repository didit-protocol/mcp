import { DIDIT_AUTH_BASE_URL, apiRequest, getAuthHeaders } from "../config";
import { redactApplication, redactCollection, pathSegment, DiditError } from "../security";

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function register(email: string, password: string): Promise<any> {
  return apiRequest("/programmatic/register/", {
    method: "POST",
    baseUrl: DIDIT_AUTH_BASE_URL,
    headers: JSON_HEADERS,
    json: { email, password },
  });
}

export async function verifyEmail(email: string, code: string): Promise<any> {
  return apiRequest("/programmatic/verify-email/", {
    method: "POST",
    baseUrl: DIDIT_AUTH_BASE_URL,
    headers: JSON_HEADERS,
    json: { email, code },
  });
}

export async function login(email: string, password: string): Promise<any> {
  // Redact any echoed api_key/client_secret; keep access_token/refresh_token (the caller needs them).
  return redactApplication(
    await apiRequest("/programmatic/login/", {
      method: "POST",
      baseUrl: DIDIT_AUTH_BASE_URL,
      headers: JSON_HEADERS,
      json: { email, password },
    }),
  );
}

export async function resendOtp(email: string): Promise<any> {
  return apiRequest("/programmatic/resend-otp/", {
    method: "POST",
    baseUrl: DIDIT_AUTH_BASE_URL,
    headers: JSON_HEADERS,
    json: { email },
  });
}

// Discovery tools work in BOTH modes: hosted/OAuth (accessToken omitted → headers default to
// the request-context user Bearer) and stdio (explicit accessToken from didit_login).
export async function listOrganizations(accessToken?: string): Promise<any> {
  return apiRequest("/organizations/me/", {
    baseUrl: DIDIT_AUTH_BASE_URL,
    headers: accessToken ? getAuthHeaders(accessToken) : undefined,
  });
}

export async function listApplications(orgId: string, accessToken?: string): Promise<any> {
  const res = await apiRequest(`/organizations/me/${pathSegment(orgId, "organization_id")}/applications/`, {
    baseUrl: DIDIT_AUTH_BASE_URL,
    headers: accessToken ? getAuthHeaders(accessToken) : undefined,
  });
  return redactCollection(res, redactApplication);
}

export async function getApplication(orgId: string, appId: string, accessToken?: string): Promise<any> {
  const res = await apiRequest(
    `/organizations/me/${pathSegment(orgId, "organization_id")}/applications/${pathSegment(appId, "application_id")}/`,
    { baseUrl: DIDIT_AUTH_BASE_URL, headers: accessToken ? getAuthHeaders(accessToken) : undefined },
  );
  return redactApplication(res);
}

/**
 * The ONLY path that returns a live, UN-redacted api_key. Requires confirm:true AND an
 * explicit organization_id + application_id (no env-default fallback). The raw key must
 * not be logged or persisted.
 */
export async function revealApplicationApiKey(
  orgId: unknown,
  appId: unknown,
  confirm: unknown,
  accessToken?: string,
): Promise<any> {
  if (typeof orgId !== "string" || !orgId.trim() || typeof appId !== "string" || !appId.trim()) {
    throw new DiditError({
      code: "missing_scope",
      message: "organization_id and application_id must both be provided explicitly to reveal a raw api_key.",
      hint: "Raw-secret tools never fall back to env/context defaults — pass both ids.",
    });
  }
  if (confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: "Revealing a live api_key exposes a secret. Re-call with confirm:true to proceed.",
      field: "confirm",
      hint: "Only reveal the key when a human explicitly needs it to integrate. Do not log or persist it.",
    });
  }
  return apiRequest(
    `/organizations/me/${pathSegment(orgId, "organization_id")}/applications/${pathSegment(appId, "application_id")}/`,
    { baseUrl: DIDIT_AUTH_BASE_URL, headers: accessToken ? getAuthHeaders(accessToken) : undefined },
  );
}
