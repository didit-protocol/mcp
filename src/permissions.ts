// Per-tool permission pre-check.
//
// The backend is the authoritative enforcer: every console endpoint the tools call is
// decorated with `@has_privileges(["<action>:<resource>"])` and refuses with a 403 when
// the caller's organization role lacks it. The introspected token already carries the
// caller's `org_permissions` (they arrive in `AuthInfo.scopes`), so the same decision can
// be taken HERE, before the request leaves: the model gets a `missing_scope` error naming
// the permission instead of an opaque 403, and tools/list can hide what the caller could
// never run. Defense in depth, same pattern as `isPrivilegedCaller`.
//
// TOOL_PERMISSIONS mirrors the backend decorators tool by tool (the PR that introduced it
// lists the endpoint behind every entry) — including their quirks, because a permission the
// backend does not actually check would block legitimate users. A value is one permission
// string, or a list when the endpoint accepts ANY ONE of several (a DRF view's
// `accepted_org_permissions`; the session create views accept `create:sessions` or
// `write:sessions`). `null` means "no pre-check": endpoints with no role check at
// all, membership-scoped ones (`/organizations/me/`), and everything that is not org/app-scoped.
// Unknown tools are never checked either.
import { DiditError } from "./security";
import { INTERNAL_TOOL_PERMISSIONS } from "./internal-tools";
import { INVESTIGATOR_TOOL_PERMISSIONS } from "./tools/investigator";
import { REGISTERED_TOOL_PERMISSIONS } from "./tools/registered";

export type PermissionMode = "shadow" | "enforce" | "off";

/** What a tool's role needs: one permission, any one of a set, or nothing to check (`null`). */
export type ToolPermission = string | readonly string[] | null;

/** Only the backend's permission strings count; `scopes` also carries OAuth scopes and
 * claims, and a token with none of the former (stdio env token) is not a role we can judge. */
const PERMISSION_RE = /^(read|write|delete|list|create|approve):[a-z-]+$/;

export const TOOL_PERMISSIONS: Record<string, ToolPermission> = {
  // ── Auth service (apx.didit.me): membership-scoped or bootstrap, no @has_privileges ──
  didit_account_device_login_poll: null, // OAuth device grant token poll on the console - account bootstrap, stdio only
  didit_account_device_login_start: null, // OAuth device authorization on the console - account bootstrap, stdio only
  didit_account_login: null, // POST auth /programmatic/login/ — account bootstrap
  didit_account_register: null, // POST auth /programmatic/register/ — account bootstrap
  didit_account_resend_otp: null, // POST auth /programmatic/resend-otp/ — account bootstrap
  didit_account_verify_2fa: null, // POST auth /2fa/verify/ — account bootstrap (login step-up)
  didit_account_verify_email: null, // POST auth /programmatic/verify-email/ — account bootstrap
  didit_context_get: null, // GET auth /organizations/me/ (+ applications) — membership-scoped
  didit_docs_search: null, // public documentation search (tools/docs.ts): no Didit endpoint, no permission
  didit_org_get_application: null, // GET auth /organizations/me/{org}/applications/{app}/ — hardcoded owner/admin check, no decorator
  didit_org_list: null, // GET auth /organizations/me/ — membership-scoped
  didit_org_list_applications: null, // GET auth /organizations/me/{org}/applications/ — hardcoded owner/admin check, no decorator
  didit_org_reveal_application_api_key: null, // same endpoint as didit_org_get_application
  // ── Billing ──
  didit_org_get_balance: ["read:subscription", "list:subscription"], // GET /organization/{org}/top-up/ → stripe.py:498
  didit_org_top_up: "write:subscription", // checkout: GET /organization/{org}/checkout-session/ → stripe.py CreateCheckoutSessionView; saved_card: POST /organization/{org}/billing/agent-top-ups/ (or POST /v3/billing/top-up/ with an API key), both write:subscription
  // ── Alerts, analytics, audit ──
  didit_analytics: ["read:analytics", "list:analytics"], // GET …/analytics/ → analytics.py:196
  // ── Standalone verification APIs (proxy.py:36 gates every …/apis/* POST on create:sessions) ──
  // The email and phone codes do not go through that proxy (it registers no email/phone send or
  // check route): they call the public APIs with the application api-key, which the
  // console application read only shows to a role holding create:sessions (app-api-key.ts).
  // ── Workflows (delete reuses write; graph helpers are read-gated POSTs) ──
  didit_workflow_build_graph: "read:workflows", // POST …/compliance/build-workflow/ → compliance.py:137
  // Internal-only families (compliance, travel rule, marketplace, networks, SDK token): empty in the public build.
  // ── Investigator (/v3/investigator/*): see tools/investigator.ts ──
  ...INVESTIGATOR_TOOL_PERMISSIONS,
  // ── Tools declared one object per tool (webhooks, branding, ...): see tools/registered.ts ──
  ...REGISTERED_TOOL_PERMISSIONS,
  ...INTERNAL_TOOL_PERMISSIONS,
};

export function isAuthenticationSetup(tool: string): boolean {
  const permission = TOOL_PERMISSIONS[tool];
  return permission === "read:authentication" || permission === "write:authentication";
}

/** Authentication setup requires an owner-approved management grant, or an API key with full access
 * (no scopes, the primary secret included) or the authentication level the operation needs. */
export function setupCredentialRefusal(tool: string, scopes: readonly string[], key?: { authenticationAccess?: "read" | "write" }): string | undefined {
  if (!isAuthenticationSetup(tool)) return;
  if (key) {
    const needed = TOOL_PERMISSIONS[tool] === "read:authentication" ? "read" : "write";
    if (key.authenticationAccess !== "write" && key.authenticationAccess !== needed) {
      return `This API key needs full access or ${needed} access to authentication.`;
    }
  } else if (!scopes.includes("didit:management")) {
    return "Authentication setup requires the didit:management scope. Reconnect with owner approval.";
  }
}

/** The permissions any one of which lets a call run: one entry, a set, or none when the map
 * has no entry for the tool (never judged). */
export function acceptedPermissions(tool: string): readonly string[] {
  const entry = TOOL_PERMISSIONS[tool];
  if (!entry) return [];

  return typeof entry === "string" ? [entry] : entry;
}

/** The permission strings in `AuthInfo.scopes` (the introspected `org_permissions`), and nothing
 * else: `scopes` also carries OAuth scopes and claims, which decide nothing here. */
export function tokenPermissions(scopes: readonly string[] | undefined): string[] {
  return (scopes ?? []).filter((scope) => PERMISSION_RE.test(scope));
}

/** "'create:sessions' or 'write:sessions'" — how a refusal and a hint name the accepted set. */
export function describePermissions(tool: string): string {
  const named = acceptedPermissions(tool).map((permission) => `'${permission}'`);
  if (named.length <= 1) return named[0] ?? "";

  return `${named.slice(0, -1).join(", ")} or ${named[named.length - 1]}`;
}

/** "the permission" / "any of the permissions", to match describePermissions. */
function permissionNoun(tool: string): string {
  return acceptedPermissions(tool).length > 1 ? "any of the permissions" : "the permission";
}

export type PermissionDecision = "allow" | "would_deny" | "deny";

export interface PermissionQuery {
  tool: string;
  /** `AuthInfo.scopes`: the introspected `org_permissions` plus OAuth scopes and claims. */
  scopes: readonly string[] | undefined;
  mode: PermissionMode;
  /** The organization the token's permissions describe (`AuthInfo.extra.organization_id`). */
  tokenOrg: string | undefined;
  /** The organization the call acts in (explicit `organization_id` argument, else the token's). */
  targetOrg: string | undefined;
}

/**
 * `allow` when the tool needs no pre-check, the call targets an organization other than
 * the one the token's permissions describe (a multi-org user routing by `organization_id`
 * — we cannot judge that org), the token carries no permission strings, or it carries one
 * of the accepted ones. Otherwise `deny` in enforce mode and `would_deny` in shadow mode
 * (the call proceeds, the audit line records the verdict).
 */
export function decidePermission({ tool, scopes, mode, tokenOrg, targetOrg }: PermissionQuery): PermissionDecision {
  const accepted = acceptedPermissions(tool);
  const judgeable = Boolean(tokenOrg) && (!targetOrg || targetOrg === tokenOrg);
  const permissions = tokenPermissions(scopes);

  const effectiveMode = isAuthenticationSetup(tool) ? "enforce" : mode;
  if (effectiveMode === "off" || accepted.length === 0 || !judgeable || permissions.length === 0) return "allow";
  if (permissions.some((permission) => accepted.includes(permission))) return "allow";

  return effectiveMode === "enforce" ? "deny" : "would_deny";
}

export function missingPermissionError(tool: string): DiditError {
  return new DiditError({
    code: "missing_scope",
    message: `Your role in this organization does not include ${permissionNoun(tool)} ${describePermissions(tool)} that ${tool} requires.`,
    field: "permission",
    hint: `Ask an organization owner or admin to grant ${describePermissions(tool)} to your role, then retry.`,
  });
}

/**
 * The caller's access to ONE organization as service-didit-auth answers it for a call NOW
 * (auth/introspection-verifier.ts `organizationAccess`). Every field is optional because an
 * answer may say less than all of it: `undefined` means "the answer did not say", while a
 * `null` role means it said there is no role for this person in this organization.
 */
export interface OrganizationAccess {
  /** The member's role name there; `null` when the service says the caller has no role in the
   *  organization — removed, suspended, or outside what this connection was granted to act in. */
  role?: string | null;
  /** The permission strings that role carries in the organization. */
  permissions?: string[];
  /** The applications the membership can open there (their uuids). */
  accessibleApplications?: string[];
}

/** Reads that access for one (token, organization) pair, fresh: never from a cache. */
export type LiveAccess = (token: string, organizationId: string) => Promise<OrganizationAccess | null>;

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The refusal for a call the caller's CURRENT membership does not allow, or undefined to go on.
 *
 * `decidePermission` above is a prediction of what the backend will demand, taken from the token
 * that was verified (and remembered) when the connection opened. This is the membership
 * service-didit-auth states at the moment of the call, for the organization the call acts in,
 * which is what makes a demotion, a removal or an application taken away reach a connection that
 * is already open: that service re-derives the answer per introspection and drops its cached copy
 * on every membership, role and application-access change, whereas the verification service
 * downstream keeps its own copy for up to 600 s and would still let the call through.
 * It refuses in shadow mode too: the alternative is forwarding a call the source of truth has
 * just forbidden, which is exactly the report. `MCP_PERMISSION_MODE=off` still turns it off.
 */
export function currentAccessRefusal({
  tool,
  permissionFor = tool,
  access,
  applicationId,
  signedInPermissions = [],
}: {
  /** The tool as the caller named it — what a refusal is about. */
  tool: string;
  /** The map key its permission lives under, when the caller named an alias (a wakeshift
   *  watch tool names the Didit tool it reads, `wakeshift.permissionAs`). */
  permissionFor?: string;
  access: OrganizationAccess;
  /** The application the call will actually use, for a tool that acts on ONE: the
   *  `application_id` it names, or the default the dispatcher resolved (index.ts, from the
   *  documented "optional when you own exactly one application"). Undefined for an
   *  organisation-level tool, which must not be refused for an application it never acts in.
   *  The default itself comes from the 60 s organisation map (orgapp.ts), which is why the
   *  comparison here is against the LIVE list and never against that map. */
  applicationId?: string;
  /** The permission strings the connection's token carried when it was verified — `tokenPermissions`
   *  over `AuthInfo.scopes`, `[]` when the introspection answer carried none. Used only to tell a
   *  change apart from a role that never had the privilege: a refusal must not claim a change that
   *  did not happen (a Reader calling a write tool was never allowed it). */
  signedInPermissions?: readonly string[];
}): string | undefined {
  const accepted = acceptedPermissions(permissionFor);
  const permissions = access.permissions;
  // No role there at all, or nothing it grants: service-didit-auth answers a removed or suspended
  // member with `org_role: null` and no permissions, and filters a connection's granted scope
  // down to the permissions it covers (none, for a scope the call needs nothing from). An EMPTY
  // list only decides the tools that accept a permission: one with no role check (permission:
  // null, e.g. the membership routes) runs whatever a role grants, so it is never "removed" for
  // listing no permissions of its own.
  const grantsNothing = accepted.length > 0 && permissions !== undefined && permissions.length === 0;
  if (access.role === null || grantsNothing) {
    return (
      `Your membership in this organization is not currently granting what ${tool} needs, so it cannot run. ` +
      "You may have been removed or suspended, your role there may not include the permission it needs, " +
      "or this connection may not have been granted it. " +
      "Check with an organization owner or admin; if your role includes it, reconnect and sign in again so this connection is granted it."
    );
  }

  const applications = access.accessibleApplications;
  if (applicationId && applications && !applications.some((app) => sameId(app, applicationId))) {
    return (
      `Your role in this organization does not include access to application ${applicationId}, so ${tool} cannot run. ` +
      "To use that application, ask an organization owner or admin to grant it to your role."
    );
  }

  if (accepted.length > 0 && permissions && !permissions.some((permission) => accepted.includes(permission))) {
    const lead = access.role
      ? `Your role in this organization is ${access.role}, which does not include`
      : "Your role in this organization does not include";
    const head =
      `${lead} ${permissionNoun(permissionFor)} ${describePermissions(permissionFor)} that ${tool} requires.`;
    // The connection signed in with the privilege and the membership no longer carries it: a change
    // that can be named, and that has already reached this connection.
    if (signedInPermissions.some((permission) => accepted.includes(permission))) {
      return `${head} An owner or admin changed it, and the change applied to this connection on this call: nothing else is needed.`;
    }
    // The membership does not carry it and nothing says it used to: say what to do, never invent a change.
    return (
      `${head} Ask an organization owner or admin to grant ${describePermissions(permissionFor)} to your role, then retry. ` +
      "If your role already includes it, this connection was not granted it: reconnect and sign in again."
    );
  }

  return undefined;
}
