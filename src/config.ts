import { readFileSync } from "fs";
import { basename } from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { DiditError, parseErrorBody, statusToCode, statusToHint, validateLocalFile } from "./security";

export const DIDIT_AUTH_BASE_URL = process.env.DIDIT_AUTH_BASE_URL || "https://apx.didit.me/auth/v2";
export const DIDIT_API_BASE_URL = process.env.DIDIT_API_BASE_URL || "https://verification.didit.me/v3";

// ── Hosted (HTTP/OAuth) mode configuration ─────────────────────────────────
// Only used by src/http.ts. The defaults target Didit production; every value is
// overridable per environment. service-didit-auth is the OAuth Authorization Server.
export const MCP_PORT = parseInt(process.env.MCP_PORT || "3000", 10);
// The RFC 8707 resource identifier for this MCP server (its public URL).
export const MCP_RESOURCE_URI = process.env.MCP_RESOURCE_URI || "https://mcp.didit.me";
// The dedicated OAuth client registered in service-didit-auth for the MCP.
export const MCP_OAUTH_CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID || "";
// Client secret used for RFC 7662 token introspection (Basic auth to the auth service).
export const MCP_OAUTH_CLIENT_SECRET = process.env.MCP_OAUTH_CLIENT_SECRET || "";
// How the resource server validates the caller's access token:
//   "introspection" (default) — RFC 7662 call to the auth service. Required because
//      service-didit-auth's OIDC code flow issues OPAQUE access tokens (not JWTs).
//   "jwks" — local JWT signature validation against DIDIT_JWKS_URL (only correct if
//      the auth service is configured to mint JWT access tokens for this client).
export const MCP_TOKEN_VERIFY_MODE = (process.env.MCP_TOKEN_VERIFY_MODE || "introspection").toLowerCase();
export const MCP_OAUTH_INTROSPECT_URL =
  process.env.MCP_OAUTH_INTROSPECT_URL || "https://apx.didit.me/auth/v2/introspect/";
// Optional: for single-org MCP deployments, the org to scope introspection to.
export const MCP_DEFAULT_ORG = process.env.MCP_DEFAULT_ORG || "";
// Optional: default application for single-app deployments (used when a tool call
// omits application_id and the user has no unambiguous default).
export const MCP_DEFAULT_APP = process.env.MCP_DEFAULT_APP || "";
// Authorization Server = the Didit business console (it hosts the "log in + confirm"
// consent at /authorize and the token exchange at /api/auth/oauth-token, returning the
// user's Didit token). Token validation still goes to the auth service via introspection.
export const MCP_AUTHORIZATION_SERVER_ORIGIN =
  process.env.MCP_AUTHORIZATION_SERVER_ORIGIN || "https://business.didit.me";
export const DIDIT_AUTH_ISSUER = process.env.DIDIT_AUTH_ISSUER || MCP_AUTHORIZATION_SERVER_ORIGIN;
export const DIDIT_OIDC_DISCOVERY_URL =
  process.env.DIDIT_OIDC_DISCOVERY_URL || `${MCP_AUTHORIZATION_SERVER_ORIGIN}/.well-known/oauth-authorization-server`;
export const DIDIT_JWKS_URL = process.env.DIDIT_JWKS_URL || "https://apx.didit.me/auth/config/jwks/";
export const DIDIT_OIDC_AUTHORIZE_URL =
  process.env.DIDIT_OIDC_AUTHORIZE_URL || `${MCP_AUTHORIZATION_SERVER_ORIGIN}/authorize`;
export const DIDIT_OIDC_TOKEN_URL =
  process.env.DIDIT_OIDC_TOKEN_URL || `${MCP_AUTHORIZATION_SERVER_ORIGIN}/api/auth/oauth-token`;
export const DIDIT_OIDC_REGISTRATION_URL =
  process.env.DIDIT_OIDC_REGISTRATION_URL || `${MCP_AUTHORIZATION_SERVER_ORIGIN}/api/auth/oauth-register`;
// Scopes advertised in discovery metadata. These MUST match the scopes the Didit
// authorization server (business console) advertises and renders plain-language consent
// for — otherwise the consent screen shows "a permission Didit can't explain". The MCP
// acts as the user with management + verification access, so it requests those two scopes
// (NOT granular read:sessions/etc., which the console doesn't recognize).
export const MCP_SCOPES_SUPPORTED = (
  process.env.MCP_SCOPES_SUPPORTED ||
  "didit:management didit:verification"
)
  .split(/\s+/)
  .filter(Boolean);

/**
 * Per-request credential context. The MCP always acts as a Didit USER: the OAuth
 * resource-server layer (hosted mode) populates this with the caller's validated user
 * Bearer token (and the org it is scoped to) for the duration of a single tool dispatch,
 * so every tool authenticates as that user WITHOUT any tool-signature change. In stdio
 * mode the same Bearer is supplied via the DIDIT_ACCESS_TOKEN env var. There is NO
 * API-key mode — every tool targets the user-scoped console endpoints, which only
 * authorize a Bearer token (an x-api-key is rejected).
 */
export interface RequestCredentials {
  accessToken?: string;
  organizationId?: string;
  applicationId?: string;
}
export const requestContext = new AsyncLocalStorage<RequestCredentials>();

/**
 * Org/app context for the console (management) endpoints.
 *
 * The hosted MCP acts AS THE USER: management tools (workflows, lists, businesses,
 * webhooks, analytics, billing, …) call the same org/app-scoped endpoints the Didit
 * console uses — `/organization/{org}/application/{app}/...` — which already authorize
 * the user's Bearer token with per-role permissions. Those paths need an org id and
 * (for most) an app id.
 *
 * Resolution order: explicit tool argument → per-request token context → env default.
 * If none resolves we throw a clear, actionable error telling the agent to discover
 * ids via didit_org_list / didit_org_list_applications.
 */
export interface OrgAppArgs {
  organizationId?: string;
  applicationId?: string;
}

export function resolveOrganizationId(explicit?: string): string {
  const org = explicit || requestContext.getStore()?.organizationId || MCP_DEFAULT_ORG;
  if (!org) {
    throw new Error(
      "organization_id is required for this operation. Call didit_context_get to discover " +
        "your organizations and applications in one call, then pass organization_id " +
        "(or use a *_search tool to span all of them at once).",
    );
  }
  return org;
}

export function resolveApplicationId(explicit?: string): string {
  const app = explicit || requestContext.getStore()?.applicationId || MCP_DEFAULT_APP;
  if (!app) {
    throw new Error(
      "application_id is required for this operation. Call didit_context_get to list your " +
        "applications, then pass application_id (or use a *_search tool to span all apps at once).",
    );
  }
  return app;
}

/** `/organization/{org}/application/{app}{resource}` — org+app-scoped console path. */
export function orgAppPath(resource: string, opts: OrgAppArgs = {}): string {
  const org = resolveOrganizationId(opts.organizationId);
  const app = resolveApplicationId(opts.applicationId);
  return `/organization/${org}/application/${app}${resource}`;
}

/** `/organization/{org}{resource}` — org-only console path (e.g. billing). */
export function orgPath(resource: string, opts: { organizationId?: string } = {}): string {
  return `/organization/${resolveOrganizationId(opts.organizationId)}${resource}`;
}

/**
 * Auth headers for the Didit APIs. The MCP always authenticates as a Didit user via a
 * Bearer access token (from the OAuth flow in hosted mode, or DIDIT_ACCESS_TOKEN in stdio
 * mode). There is no API-key path — the user-scoped console endpoints reject x-api-key.
 */
function authHeaders(): Record<string, string> {
  const ctx = requestContext.getStore();
  if (ctx?.accessToken) {
    const headers: Record<string, string> = { Authorization: `Bearer ${ctx.accessToken}` };
    // Tells the verification API which authorized org this request acts in
    // (required for multi-org user tokens; harmless for single-org).
    if (ctx.organizationId) {
      headers["X-Didit-Organization-Id"] = ctx.organizationId;
    }
    return headers;
  }
  return {};
}

export function getHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeaders() };
}

export function getMultipartHeaders(): Record<string, string> {
  // Multipart calls: omit Content-Type so fetch sets the multipart boundary. Same Bearer auth.
  return authHeaders();
}

export function getAuthHeaders(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

export interface ApiRequestOptions {
  method?: string;
  /** JSON request body. */
  json?: any;
  /** Multipart body. When set, the request uses API-key-only headers (no Content-Type) so fetch sets the boundary. */
  form?: FormData;
  /** Query-string params; undefined/null values are skipped, others stringified. */
  params?: Record<string, any>;
  /** Override the base URL (defaults to the verification API). */
  baseUrl?: string;
  /** Override request headers (e.g. Bearer auth for the auth API). */
  headers?: Record<string, string>;
}

/**
 * Single entry point for every Didit HTTP call. Centralizes auth headers, query
 * building, 204 handling, and — importantly — error handling: a non-2xx response
 * throws with the status and body so the MCP dispatch surfaces it as a tool error
 * instead of silently returning the error body as if it were a success.
 */
export async function apiRequest(path: string, opts: ApiRequestOptions = {}): Promise<any> {
  const { method = "GET", json, form, params, baseUrl = DIDIT_API_BASE_URL, headers } = opts;

  const url = new URL(`${baseUrl}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const resolvedHeaders = headers ?? (form ? getMultipartHeaders() : getHeaders());
  const init: RequestInit = { method, headers: resolvedHeaders };
  if (form) {
    init.body = form;
  } else if (json !== undefined) {
    init.body = JSON.stringify(json);
  }

  const res = await fetch(url.toString(), init);

  if (res.status === 204) return { success: true };

  const text = await res.text();
  let body: any = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!res.ok) {
    const parsed = parseErrorBody(body);
    throw new DiditError({
      code: statusToCode(res.status),
      message: parsed.message || `Request failed with status ${res.status}.`,
      hint: statusToHint(res.status, body),
      field: parsed.field,
      allowed: parsed.allowed,
      status: res.status,
    });
  }

  return body;
}

/**
 * Build a multipart/form-data body from file paths and optional scalar fields.
 * Shared by the standalone image endpoints and branding customization.
 */
export function buildFormData(
  files: Record<string, string | undefined>,
  scalars: Record<string, any> = {},
): FormData {
  const form = new FormData();
  for (const [key, filePath] of Object.entries(files)) {
    if (!filePath) continue;
    const safePath = validateLocalFile(filePath, key);
    const buffer = readFileSync(safePath);
    form.append(key, new Blob([buffer]), basename(safePath));
  }
  for (const [key, value] of Object.entries(scalars)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "string" ? value : String(value));
  }
  return form;
}
