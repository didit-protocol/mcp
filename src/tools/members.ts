import { apiRequest, resolveOrganizationId, DIDIT_AUTH_BASE_URL } from "../config";
import { redactApiKey, redactCollection, pathSegment } from "../security";

// Org members / roles / API keys — served by service-didit-auth (apx/auth/v2), org-level,
// with the user Bearer. org resolves from the tool arg / token context (resolveOrganizationId).

function authPath(org: string, resource: string): string {
  return `/organizations/${pathSegment(org, "organization_id")}${resource}`;
}

export async function listMembers(organizationId?: string, params?: Record<string, any>): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  return apiRequest(authPath(org, "/members/"), { baseUrl: DIDIT_AUTH_BASE_URL, params });
}

export async function inviteMember(data: Record<string, any>, organizationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  // POST /members/invite/ — the collection route above is GET-only, so an invite sent there
  // answers 405. InviteMemberSerializer takes exactly emails (1-5), role and app_ids; build
  // the body from those fields rather than forwarding the tool args verbatim.
  return apiRequest(authPath(org, "/members/invite/"), {
    baseUrl: DIDIT_AUTH_BASE_URL,
    method: "POST",
    json: { emails: data.emails, role: data.role, app_ids: data.app_ids },
  });
}

export async function updateMember(memberId: string, data: Record<string, any>, organizationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  // The detail route is declared WITHOUT a trailing slash (APPEND_SLASH only adds one), and
  // OrganizationMemberUpdateSerializer takes role + accessible_applications — member_id is a
  // path segment, not a body field.
  return apiRequest(authPath(org, `/members/${pathSegment(memberId, "member_id")}`), {
    baseUrl: DIDIT_AUTH_BASE_URL,
    method: "PATCH",
    json: { role: data.role, accessible_applications: data.accessible_applications },
  });
}

export async function removeMember(memberId: string, organizationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  // Same detail route, no trailing slash.
  return apiRequest(authPath(org, `/members/${pathSegment(memberId, "member_id")}`), { baseUrl: DIDIT_AUTH_BASE_URL, method: "DELETE" });
}

export async function listRoles(organizationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  return apiRequest(authPath(org, "/roles/"), { baseUrl: DIDIT_AUTH_BASE_URL });
}

export async function listApiKeys(organizationId?: string, applicationId?: string): Promise<any> {
  const org = resolveOrganizationId(organizationId);
  // Console api-keys are nested under the application; if an app id is given use it.
  const path = applicationId
    ? `/organizations/${pathSegment(org, "organization_id")}/applications/${pathSegment(applicationId, "application_id")}/api-keys/`
    : authPath(org, "/api-keys/");
  const res = await apiRequest(path, { baseUrl: DIDIT_AUTH_BASE_URL });
  return redactCollection(res, redactApiKey);
}
