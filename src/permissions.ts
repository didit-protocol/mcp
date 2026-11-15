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
// backend does not actually check would block legitimate users. `null` means "no
// pre-check": endpoints without a decorator, membership-scoped ones (`/organizations/me/`),
// and everything that is not org/app-scoped. Unknown tools are never checked either.
import { DiditError } from "./security";
import { INTERNAL_TOOL_PERMISSIONS } from "./internal-tools";
import { INVESTIGATOR_TOOL_PERMISSIONS } from "./tools/investigator";
import { REGISTERED_TOOL_PERMISSIONS } from "./tools/registered";

export type PermissionMode = "shadow" | "enforce" | "off";

/** Only the backend's permission strings count; `scopes` also carries OAuth scopes and
 * claims, and a token with none of the former (stdio env token) is not a role we can judge. */
const PERMISSION_RE = /^(read|write|delete|list|create|approve):[a-z-]+$/;

export const TOOL_PERMISSIONS: Record<string, string | null> = {
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
  didit_org_get_balance: "read:subscription", // GET /organization/{org}/top-up/ → stripe.py:498
  didit_org_top_up: "write:subscription", // checkout: GET /organization/{org}/checkout-session/ → stripe.py CreateCheckoutSessionView; saved_card: POST /organization/{org}/billing/agent-top-ups/ (or POST /v3/billing/top-up/ with an API key), both write:subscription
  // ── Alerts, analytics, audit ──
  didit_analytics: "read:analytics", // GET …/analytics/ → analytics.py:196
  // ── Standalone verification APIs (proxy.py:36 gates every …/apis/* POST on create:sessions) ──
  // The phone OTP pair does not go through that proxy (it registers no phone/send or
  // phone/check route): it calls the public APIs with the application api-key, which the
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
 * — we cannot judge that org), the token carries no permission strings, or it carries the
 * required one. Otherwise `deny` in enforce mode and `would_deny` in shadow mode (the call
 * proceeds, the audit line records the verdict).
 */
export function decidePermission({ tool, scopes, mode, tokenOrg, targetOrg }: PermissionQuery): PermissionDecision {
  const required = TOOL_PERMISSIONS[tool];
  const judgeable = Boolean(tokenOrg) && (!targetOrg || targetOrg === tokenOrg);
  const permissions = (scopes ?? []).filter((scope) => PERMISSION_RE.test(scope));

  if (mode === "off" || !required || !judgeable || permissions.length === 0 || permissions.includes(required)) {
    return "allow";
  }

  return mode === "enforce" ? "deny" : "would_deny";
}

export function missingPermissionError(tool: string): DiditError {
  const required = TOOL_PERMISSIONS[tool];

  return new DiditError({
    code: "missing_scope",
    message: `Your role in this organization does not include the permission '${required}' that ${tool} requires.`,
    field: "permission",
    hint: `Ask an organization owner or admin to grant '${required}' to your role, then retry.`,
  });
}
