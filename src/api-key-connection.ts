/**
 * API key connections: a hosted connection that authenticates with an application API key
 * instead of a person's sign-in.
 *
 * Why: an agent that runs with no person present (CI, a scheduled job, a backend agent) has no
 * browser to finish an OAuth sign-in in, and a person's access token lasts a day. It already
 * holds the credential it sends to the Didit API, so the hosted server takes that one:
 *
 *   Authorization: Bearer <api key>     or     x-api-key: <api key>
 *
 * on `/mcp` and `/mcp/payments`. Nothing changes for a client that signs in with OAuth.
 *
 * What such a connection is: ONE application. The key is forwarded to the Didit API as
 * `x-api-key`, and the API decides what it may do, exactly as on a direct API call: a
 * full-access key reaches every route of its own application, a restricted key the resources it
 * was given (service-didit-verification `core/api_key_access.py`). Nothing here grants anything.
 *
 * What it is not: a person. Tools that act for a member of an organization (members, roles, API
 * key management, plans, cards, receipts) are neither listed nor run on it, and neither are the
 * download links, which carry the caller's credential inside the link.
 */
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { INTERNAL_PERSON_ONLY_TOOLS } from "./internal-tools";

/** The application an API key belongs to: everything its connection can act on. */
export interface ApiKeyScope {
  organizationId: string;
  organizationName?: string;
  applicationId: string;
  applicationName?: string;
  /** "live" | "sandbox", as the auth service reports it. */
  mode?: string;
  /** A named key's id. The application's primary key has none. */
  keyId?: string;
  /** The key's label and display prefix as the console shows them (never the key). */
  keyLabel?: string;
  keyPrefix?: string;
  /** True for the application's primary key. */
  primary: boolean;
  /** True when the key is limited to some resources; false for a full-access key. */
  restricted: boolean;
}

/**
 * A Didit access token is a JWT (three dot-separated parts). An API key is URL-safe random text,
 * with or without the `sk_live_` / `sk_test_` marker, and never contains a dot. So the shape
 * alone tells them apart, and each credential costs exactly one introspection.
 */
export function looksLikeApiKey(credential: string): boolean {
  return credential.length > 0 && !credential.includes(".");
}

/**
 * How long an accepted key is trusted before the auth service is asked again. The MCP SDK refuses a
 * credential that has no expiry, and a key has none of its own; this one is renewed on every
 * introspection, so it only bounds how long a single answer is reused.
 */
const KEY_ANSWER_LIFETIME_S = 3600;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** Epoch seconds of an ISO date or a number of seconds; undefined for anything else. */
function epochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;

  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

/**
 * The AuthInfo of an accepted API key, from the auth service's introspection answer
 * (service-didit-auth `TokenProcessor.verify_api_key`): `sub` is the application, and `api_key`
 * carries the key's own limits.
 *
 * `scopes` is empty on purpose. The permission pre-check (permissions.ts) compares a person's
 * role permissions; a key has none, and the API enforces the key's own access on every call.
 */
export function apiKeyAuthInfo(key: string, data: Record<string, unknown>, resource: URL, now: number = Date.now()): AuthInfo {
  const applicationId = text(data.sub);
  const organizationId = text(data.organization_id);
  if (!applicationId || !organizationId) {
    throw new InvalidTokenError("The API key could not be matched to an application.");
  }
  const access = (data.api_key && typeof data.api_key === "object" ? data.api_key : {}) as Record<string, unknown>;
  // The API checks the allowlist against the address a request comes from, and through this
  // server that is the server's own address, never the caller's. Say so once, here, instead of
  // letting every tool call fail with an address the person has never seen.
  if (Array.isArray(access.allowed_ips) && access.allowed_ips.length > 0) {
    throw new InvalidTokenError(
      "This API key is limited to specific IP addresses, so it cannot be used through the hosted MCP server. " +
        "Use a key without an IP limit, or sign in with OAuth.",
    );
  }
  const nowSeconds = Math.floor(now / 1000);
  // `expires_at` is already the earlier of the key's own expiry and, for a secret that was
  // rotated, the end of the old secret's grace period (service-didit-auth `access_payload`).
  const ownExpiry = epochSeconds(access.expires_at);
  const scope: ApiKeyScope = {
    organizationId,
    organizationName: text(data.organization_name),
    applicationId,
    applicationName: text(data.application_name),
    mode: text(data.application_mode),
    keyId: text(access.uuid),
    keyLabel: text(access.label),
    keyPrefix: text(access.prefix),
    primary: access.primary === true,
    restricted: access.scopes !== null && access.scopes !== undefined,
  };

  return {
    token: key,
    clientId: text(data.client_id) ?? "api-key",
    scopes: [],
    expiresAt: Math.min(ownExpiry ?? Infinity, nowSeconds + KEY_ANSWER_LIFETIME_S),
    resource,
    extra: {
      credential: "api_key",
      api_key: scope,
      organization_id: organizationId,
      sub: applicationId,
      is_privileged: false,
      has_2fa_enabled: false,
    },
  };
}

/** The application behind the connection when it authenticated with an API key; undefined for a person's sign-in. */
export function apiKeyScopeOf(authInfo: AuthInfo | undefined): ApiKeyScope | undefined {
  const extra = authInfo?.extra as Record<string, unknown> | undefined;
  if (extra?.credential !== "api_key") return undefined;

  return extra.api_key as ApiKeyScope;
}

/**
 * Tools an API key connection neither lists nor runs.
 *
 * All but the last group act for a MEMBER of an organization, on routes the auth service and the
 * console API only open to a person's sign-in (an application credential is refused there). The
 * list was checked against the API with a real key: every read-only tool that takes no argument
 * was called through an API key connection, and the ones refused by design are here. The download
 * links seal the caller's credential inside the link; a person's token inside one stops working
 * within a day, a key would not.
 */
export const PERSON_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Members, roles and API key management (service-didit-auth, a person's sign-in only).
  "didit_org_list_members",
  "didit_org_invite_member",
  "didit_org_update_member",
  "didit_org_remove_member",
  "didit_org_list_roles",
  "didit_org_list_api_keys",
  "didit_org_create_api_key",
  "didit_org_reveal_application_api_key",
  // The audit log and the workflow builder: the API answers a member of the organization only.
  "didit_audit_log_list",
  "didit_workflow_build_graph",
  ...INTERNAL_PERSON_ONLY_TOOLS,
  // The organization's plan, cards, receipts and billing details (organization-wide console routes).
  "didit_billing_get_plan",
  "didit_billing_quote_plan",
  "didit_billing_list_payment_methods",
  "didit_billing_list_receipts",
  "didit_billing_get_details",
  "didit_billing_update_details",
  // Download links that carry the caller's credential.
  "didit_session_generate_pdf",
  "didit_session_get_signature_evidence",
  "didit_session_get_signed_document",
  "didit_session_get_signature_field_image",
]);

const DOWNLOAD_TOOLS: ReadonlySet<string> = new Set([
  "didit_session_generate_pdf",
  "didit_session_get_signature_evidence",
  "didit_session_get_signed_document",
  "didit_session_get_signature_field_image",
]);

/** Why a person-only tool does not run on an API key connection, and what to do instead. */
export function personOnlyRefusal(name: string): string {
  if (DOWNLOAD_TOOLS.has(name)) {
    return (
      `'${name}' returns a download link, which is only issued to a person's sign-in. With an API key, ` +
      "request the file from the Didit API directly (the same x-api-key), or connect with OAuth."
    );
  }

  return (
    `'${name}' acts for a member of the organization, and this connection uses an API key, which is one ` +
    "application and no person. A person does this in the Didit console, or through a connection that signs in with OAuth."
  );
}

/** Why a call that names another organization or application is refused, or undefined when it may proceed. */
export function apiKeyScopeRefusal(
  scope: ApiKeyScope,
  organizationId: string | undefined,
  applicationId: string | undefined,
): string | undefined {
  const differs = (asked: string | undefined, own: string) => asked !== undefined && asked.toLowerCase() !== own.toLowerCase();
  if (!differs(organizationId, scope.organizationId) && !differs(applicationId, scope.applicationId)) return undefined;

  return (
    `This connection uses an API key, which acts on one application only: ${scope.applicationId}` +
    `${scope.applicationName ? ` (${scope.applicationName})` : ""} in organization ${scope.organizationId}. ` +
    "Omit organization_id and application_id, or pass these. To work on another application, connect with that application's key."
  );
}

/** The key's organization, as `didit_org_list` answers for a person. */
export function apiKeyOrganizations(scope: ApiKeyScope): Record<string, unknown>[] {
  return [{ uuid: scope.organizationId, name: scope.organizationName ?? scope.organizationId }];
}

/** The key's application, as `didit_org_list_applications` and `didit_org_get_application` answer for a person. */
export function apiKeyApplication(scope: ApiKeyScope): Record<string, unknown> {
  return {
    uuid: scope.applicationId,
    name: scope.applicationName ?? scope.applicationId,
    ...(scope.mode ? { mode: scope.mode } : {}),
    organization_id: scope.organizationId,
  };
}
