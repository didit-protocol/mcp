import { apiRequest, resolveOrganizationId, DIDIT_AUTH_BASE_URL } from "../config";
import { assertBoolean, DiditError, redactApiKey, redactCollection, pathSegment } from "../security";

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
  // API keys exist only under their application: there is no organization-level route.
  if (!applicationId) {
    throw new DiditError({
      code: "bad_request",
      message: "application_id is required: API keys belong to an application.",
      field: "application_id",
      hint: "Read the organization's applications with didit_context_get, then call this once per application.",
    });
  }
  const path = `/organizations/${pathSegment(org, "organization_id")}/applications/${pathSegment(applicationId, "application_id")}/api-keys/`;
  const res = await apiRequest(path, { baseUrl: DIDIT_AUTH_BASE_URL });
  return redactCollection(res, redactApiKey);
}

// What an agent key may be limited to; the auth service caps it at the signed-in person and the
// grant whatever is asked (service-didit-auth organizations/services/agent_api_keys.py).
const KEY_RESOURCES = [
  "sessions", "decisions", "media", "users", "businesses", "transactions", "workflows", "webhooks", "applications", "analytics",
];
const KEY_LEVELS = ["read", "write"];

/**
 * Create the ONE API key this connected app may hold for an application (the x-api-key the integration
 * being built sends to the verification API). The backend enforces every rule: scoped to what the
 * signed-in person can do within the grant (never full access, never API key management), one live
 * key per connected app and application (409 otherwise), rate-limited, audit-logged, listed with the
 * connected app in the console and revoked with it. The secret is in this response only.
 */
export async function createApiKey(
  organizationId: unknown,
  applicationId: unknown,
  args: Record<string, any>,
): Promise<any> {
  if (typeof organizationId !== "string" || !organizationId.trim() || typeof applicationId !== "string" || !applicationId.trim()) {
    throw new DiditError({
      code: "missing_scope",
      message: "organization_id and application_id must both be passed explicitly to create an API key.",
      hint: "Read them from didit_context_get. Use the application's mode: a sandbox key for building and testing, a live key to go live.",
    });
  }
  assertBoolean(args?.confirm, "confirm");
  if (args?.confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: "Creating an API key issues a live credential. Re-call with confirm:true once the person agreed.",
      field: "confirm",
      hint: "Say which application the key is for and where you will store it (a secret manager or the project's .env, never committed).",
    });
  }
  const body: Record<string, unknown> = { label: typeof args?.label === "string" && args.label.trim() ? args.label.trim() : "Created by an AI agent" };
  if (args?.scopes !== undefined) {
    const scopes = args.scopes;
    if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) {
      throw new DiditError({ code: "bad_request", message: "scopes must be an object of resource to read or write.", field: "scopes", allowed: KEY_RESOURCES });
    }
    for (const [resource, level] of Object.entries(scopes)) {
      if (!KEY_RESOURCES.includes(resource) || !KEY_LEVELS.includes(String(level))) {
        throw new DiditError({
          code: "bad_request",
          message: `scopes.${resource} must be one of ${KEY_RESOURCES.join(", ")} set to read or write.`,
          field: "scopes",
          allowed: KEY_RESOURCES,
        });
      }
    }
    body.scopes = scopes;
  }
  for (const field of ["workflow_ids", "approved_sessions_only", "allowed_ips", "expires_at"]) {
    if (args?.[field] !== undefined) body[field] = args[field];
  }
  const path = `/organizations/${pathSegment(organizationId, "organization_id")}/applications/${pathSegment(applicationId, "application_id")}/api-keys/`;
  const created = await apiRequest(path, { method: "POST", baseUrl: DIDIT_AUTH_BASE_URL, json: body });
  return {
    ...created,
    shown_once: true,
    next_steps:
      "Store api_key now in the project's secret store or .env (never commit it, never repeat it in the chat): it is " +
      "never shown again. Send it as the x-api-key header to https://verification.didit.me/v3. The person can see and " +
      "revoke this key in the Didit console under the application's API keys and with this connected app.",
  };
}
