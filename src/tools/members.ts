import { apiRequest, resolveOrganizationId, DIDIT_AUTH_BASE_URL } from "../config";
import { redactApiKey, redactCollection, pathSegment } from "../security";

// Org members / roles / API keys — served by service-didit-auth (apx/auth/v2), org-level,
// with the user Bearer. org resolves from the tool arg / token context (resolveOrganizationId).

function authPath(org: string, resource: string): string {
  return `/organizations/${org}${resource}`;
}

export async function listMembers(organizationId?: string, params?: Record<string, any>): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  return apiRequest(authPath(org, "/members/"), { baseUrl: DIDIT_AUTH_BASE_URL, params });
}

export async function inviteMember(data: Record<string, any>, organizationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  return apiRequest(authPath(org, "/members/"), { baseUrl: DIDIT_AUTH_BASE_URL, method: "POST", json: data });
}

export async function updateMember(memberId: string, data: Record<string, any>, organizationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  return apiRequest(authPath(org, `/members/${memberId}/`), { baseUrl: DIDIT_AUTH_BASE_URL, method: "PATCH", json: data });
}

export async function removeMember(memberId: string, organizationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  return apiRequest(authPath(org, `/members/${memberId}/`), { baseUrl: DIDIT_AUTH_BASE_URL, method: "DELETE" });
}

export async function listRoles(organizationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  return apiRequest(authPath(org, "/roles/"), { baseUrl: DIDIT_AUTH_BASE_URL });
}

export async function listApiKeys(organizationId?: string, applicationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  // Console api-keys are nested under the application; if an app id is given use it.
  const path = applicationId
    ? `/organizations/${org}/applications/${pathSegment(applicationId, "application_id")}/api-keys/`
    : authPath(org, "/api-keys/");
  const res = await apiRequest(path, { baseUrl: DIDIT_AUTH_BASE_URL });
  return redactCollection(res, redactApiKey);
}
