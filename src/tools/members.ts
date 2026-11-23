import { apiRequest, resolveOrganizationId, DIDIT_AUTH_BASE_URL } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
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

// The resources an agent key may hold are the auth service's to say (service-didit-auth
// organizations/services/agent_api_keys.py: any resource a console key can hold (api-keys is not a resource: the backend
// drops it), capped at the signed-in person and the grant; no scopes means everything the person can do). This tool checks the SHAPE of the request and relays
// the backend's refusal, which names the resource: a copy of the list here is what kept Bank data out of reach.
const KEY_LEVELS = ["read", "write"];
const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Create the ONE API key this connected app may hold for an application (the x-api-key the integration
 * being built sends to the verification API). The backend enforces every rule: scoped to what the
 * signed-in person can do within the grant (never more than you can do), one live
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
      throw new DiditError({ code: "bad_request", message: "scopes must be an object of resource to read or write.", field: "scopes" });
    }
    for (const [resource, level] of Object.entries(scopes)) {
      if (!RESOURCE_NAME.test(resource) || !KEY_LEVELS.includes(String(level))) {
        throw new DiditError({
          code: "bad_request",
          message: `scopes.${resource} must be a resource name (for example sessions or bank-data) set to ${KEY_LEVELS.join(" or ")}.`,
          field: "scopes",
          allowed: KEY_LEVELS,
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

// ── The organization member and API key tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const ORG_MEMBER_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_org_list_members",
      description: "List the organization's members.",
      inputSchema: { type: "object" as const, properties: { organization_id: ORG_APP_PROPS.organization_id } },
    },
    // The auth service path is built from the organization the caller sent; the ids never reach the request body.
    access: "read",
    permission: ["list:members", "read:members"], // GET auth /organizations/{org}/members/ → member.py:141
    routingIds: true,
    run: ({ organization_id, application_id: _app, ...params }) => listMembers(organization_id, params),
  },
  {
    def: {
      name: "didit_org_invite_member",
      description: "Invite up to 5 members to the organization (emails + role + the applications they may access).",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: ORG_APP_PROPS.organization_id,
          emails: { type: "array", items: { type: "string" }, description: "Email addresses to invite (1-5)." },
          role: { type: "string", description: "Role UUID (from didit_org_list_roles)." },
          app_ids: { type: "array", items: { type: "string" }, description: "Application UUIDs the invitee may access (from didit_org_list_applications)." },
        },
        required: ["emails", "role", "app_ids"],
      },
    },
    access: "write",
    openWorld: true,
    permission: "write:members", // POST auth /organizations/{org}/members/invite/ → member.py:394
    routingIds: true,
    run: ({ organization_id, application_id: _app, ...data }) => inviteMember(data, organization_id),
  },
  {
    def: {
      name: "didit_org_update_member",
      description: "Update a member's role and the applications they may access.",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: ORG_APP_PROPS.organization_id,
          member_id: { type: "string", description: "Member UUID (from didit_org_list_members)." },
          role: { type: "string", description: "Role UUID (from didit_org_list_roles)." },
          accessible_applications: { type: "array", items: { type: "string" }, description: "Application UUIDs the member may access (from didit_org_list_applications)." },
        },
        required: ["member_id", "role", "accessible_applications"],
      },
    },
    access: "write",
    permission: "write:members", // PATCH auth /organizations/{org}/members/{id}/ → member.py:76
    routingIds: true,
    run: ({ organization_id, application_id: _app, ...data }) => updateMember(data.member_id, data, organization_id),
  },
  {
    def: {
      name: "didit_org_remove_member",
      description:
        "Remove a member from the organization. It cannot be undone: to come back the person has to be invited again.",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: ORG_APP_PROPS.organization_id,
          member_id: {
            type: "string",
            description: "The `uuid` of the member's row in didit_org_list_members. Not `user_id`, and not the email address.",
          },
        },
        required: ["member_id"],
      },
    },
    access: "destructive",
    permission: "delete:members", // DELETE auth /organizations/{org}/members/{id}/ → member.py:109
    routingIds: true,
    run: (args) => removeMember(args.member_id, args.organization_id),
  },
  {
    def: {
      name: "didit_org_list_roles",
      description: "List the roles available in the organization.",
      inputSchema: { type: "object" as const, properties: { organization_id: ORG_APP_PROPS.organization_id } },
    },
    access: "read",
    permission: ["list:roles", "read:roles"], // GET auth /organizations/{org}/roles/ → roles.py:55
    routingIds: true,
    run: (args) => listRoles(args.organization_id),
  },
  {
    def: {
      name: "didit_org_create_api_key",
      description:
        "Create the API key the integration you are building needs (sent as x-api-key to the verification API), " +
        "for one application. Didit allows ONE live key per connected app and application, scoped to what the " +
        "signed-in person can do (never more than you can do), rate-limited and audit-logged; " +
        "the person sees it with this connected app in the console and can revoke it there. The secret is returned " +
        "ONCE: write it straight to the project's secret store or .env and never repeat it in the chat. Without " +
        "scopes the key gets EVERYTHING the person can do within what this connected app was consented to, Bank " +
        "data (bank-data) and the Authentication setup (authentication) included; pass scopes to ask for less, e.g. " +
        "{\"sessions\": \"write\"}. Each resource is capped at the person's role (write needs write) and at the app's " +
        "consent; the backend refuses anything beyond that and names the resource. Never more than the approving person can do: without scopes it holds everything they can do, Bank data and Authentication included. No API key can manage API keys (that needs a signed-in person), so the key cannot create or revoke keys. Pick the " +
        "application by its mode in didit_context_get: a sandbox key to build and test for free, a live key to go " +
        "live. Requires confirm:true after the person agreed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: { type: "string", description: "REQUIRED. The organization (from didit_context_get)." },
          application_id: { type: "string", description: "REQUIRED. The application the key is for (from didit_context_get)." },
          label: { type: "string", description: "Name shown in the console, e.g. 'Acme backend (Codex)'." },
          scopes: {
            type: "object",
            description:
              "Optional narrower access: resource -> 'read' | 'write' (for example sessions, decisions, media, users, businesses, " +
              "transactions, workflows, webhooks, applications, analytics, messages, authentication, bank-data). " +
              "Omit it for everything the person can do within the app's consent, bank-data and authentication included. " +
              "The backend caps every entry at the person's role and names any resource it refuses.",
            additionalProperties: { type: "string", enum: ["read", "write"] },
          },
          workflow_ids: { type: "array", items: { type: "string" }, description: "Optional: only these workflows' sessions (needs scopes)." },
          expires_at: { type: "string", description: "Optional ISO 8601 expiry." },
          confirm: {
            type: "boolean",
            description: "REQUIRED. Must be true - issues a credential shown once. Only set after explicit user confirmation of this exact action.",
          },
        },
        required: ["organization_id", "application_id", "confirm"],
      },
    },
    // Issues a credential: a client asks before running it.
    access: "destructive",
    permission: "write:api-keys", // POST auth /organizations/{org}/applications/{app}/api-keys/ → application_api_keys.py (agent rules: services/agent_api_keys.py)
    routingIds: true,
    run: ({ organization_id, application_id, ...data }) => createApiKey(organization_id, application_id, data),
  },
  {
    def: {
      name: "didit_org_list_api_keys",
      description: "List one application's API key metadata with raw key values redacted. API keys belong to an application, so application_id is required: read it from didit_context_get.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS }, required: ["application_id"] },
    },
    access: "read",
    permission: ["read:applications", "list:applications"], // GET auth /organizations/{org}/applications/{app}/api-keys/ → application_api_keys.py:24
    routingIds: true,
    run: (args) => listApiKeys(args.organization_id, args.application_id),
  },
];
