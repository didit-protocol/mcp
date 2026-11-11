import { AsyncLocalStorage } from "node:async_hooks";
import { DiditError, parseErrorBody, statusToCode, statusToHint, resolveFileSource, pathSegment } from "./security";
import type { FileSource } from "./security";
import type { ApiKeyScope } from "./api-key-connection";

// Single source of truth for the version: package.json (falls back if unreadable).
function readPackageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../package.json").version || "5.0.0";
  } catch {
    return "5.0.0";
  }
}
export const SERVER_VERSION = readPackageVersion();

/**
 * Per-tool permission pre-check (permissions.ts): `shadow` (default) only records what
 * WOULD be denied on the audit line, `enforce` refuses the call and hides the tool from
 * tools/list, `off` disables the check. Read per call so a deployment can flip it by env.
 */
export function permissionMode(): "shadow" | "enforce" | "off" {
  const mode = process.env.MCP_PERMISSION_MODE;

  return mode === "enforce" || mode === "off" ? mode : "shadow";
}

export const DIDIT_AUTH_BASE_URL = process.env.DIDIT_AUTH_BASE_URL || "https://apx.didit.me/auth/v2";
export const DIDIT_API_BASE_URL = process.env.DIDIT_API_BASE_URL || "https://verification.didit.me/v3";

// ── Hosted (HTTP/OAuth) mode configuration ─────────────────────────────────
// Only used by src/http.ts. The defaults target Didit production; every value is
// overridable per environment. service-didit-auth is the OAuth Authorization Server.
export const MCP_PORT = parseInt(process.env.MCP_PORT || "3000", 10);
// The RFC 8707 / RFC 9728 resource identifier for this MCP server.
// It must match the actual Streamable HTTP transport endpoint.
// Unlisted hosted endpoint that also offers didit_org_top_up (agent payments); see http.ts.
export const MCP_PAYMENTS_PATH = "/mcp/payments";
export const MCP_RESOURCE_URI = process.env.MCP_RESOURCE_URI || "https://mcp.didit.me/mcp";
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
// How long an accepted token is remembered before it is introspected again (auth/cached-verifier.ts).
// Every MCP request is its own authenticated POST; 0 introspects every one of them.
// A mistyped or negative value falls back to the default rather than turning the cache off.
export const MCP_INTROSPECTION_CACHE_TTL_MS = nonNegativeMs(process.env.MCP_INTROSPECTION_CACHE_TTL_MS, 60_000);

function nonNegativeMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
// "Mixed auth" (MCP 2026-07-28 + RFC 9728): serve the PROTOCOL-NEGOTIATION surface without a
// Bearer, and keep every tool behind OAuth exactly as before. `initialize`, its notification,
// and `server/discover` return only the server name, version, capabilities and supported
// protocol versions - none of which is private, and all of which a client must read BEFORE it
// can know how to authenticate. Several hosts (managed MCP hosting platforms, MCP directory crawlers)
// probe with `server/discover` before any OAuth dance and treat the 401 as a hard connection
// failure, so an all-or-nothing 401 makes the server undiscoverable to them.
//
// OFF by default: mcp.didit.me keeps answering 401 to every request, unchanged. Turn it on per
// deployment (a gateway-hosted copy, a directory listing) with MCP_PUBLIC_DISCOVERY=true.
// tools/list and tools/call are NEVER public under this flag - the catalog stays authenticated.
export const MCP_PUBLIC_DISCOVERY = process.env.MCP_PUBLIC_DISCOVERY === "true";
// What this build supports, reported by GET /healthz so a client can adapt to the server it is
// about to connect to. The console's connect screen offers a read-only connection only where
// the server lists `read_only`: against a server that predates it the parameter is ignored,
// and the person would believe a connection is read-only when it is not.
// `api_key`: the hosted endpoint also takes an application API key in place of a sign-in
// (api-key-connection.ts), so a client can offer that choice only where it works.
// Only where tokens are introspected: a deployment that verifies JWTs locally (jwks) cannot accept a key.
export const SERVER_FEATURES: readonly string[] = [
  "toolsets",
  "read_only",
  "tool_discovery",
  "prompts",
  ...(MCP_TOKEN_VERIFY_MODE === "jwks" ? [] : ["api_key"]),
];
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
// (NOT granular read:sessions/etc., which the console doesn't recognize). `didit:staff` is
// identity-only: the auth service issues it to staff users alone, and only a token carrying it
// introspects with `is_staff: true` — which is what opens the staff tools (see
// isPrivilegedCaller). Non-staff users simply never receive it.
export const MCP_SCOPES_SUPPORTED = (
  process.env.MCP_SCOPES_SUPPORTED ||
  "didit:management didit:verification didit:staff"
)
  .split(/\s+/)
  .filter(Boolean);

/**
 * Per-request credential context. The MCP normally acts as a Didit USER: the OAuth
 * resource-server layer (hosted mode) populates this with the caller's validated user
 * Bearer token (and the org it is scoped to) for the duration of a single tool dispatch,
 * so every tool authenticates as that user WITHOUT any tool-signature change. In stdio
 * mode the same Bearer is supplied via the DIDIT_ACCESS_TOKEN env var.
 *
 * A hosted connection may authenticate with an application API key instead
 * (api-key-connection.ts). Then `apiKey` is set and `accessToken` is not: every request goes
 * out with `x-api-key`, and the connection is the one application in `apiKeyScope`.
 */
export interface RequestCredentials {
  accessToken?: string;
  /** The application API key of an API key connection. Never set together with accessToken. */
  apiKey?: string;
  /** The application that key belongs to. */
  apiKeyScope?: ApiKeyScope;
  organizationId?: string;
  applicationId?: string;
  /** Tool being dispatched — sent as User-Agent so the backend audit log attributes the request. */
  toolName?: string;
  /** Where the user acted from, sent to the Investigator as X-Didit-Actor-Via: "copilot" when the
   *  console assistant said so on the MCP request, otherwise "mcp". */
  actorVia?: "copilot" | "mcp";
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
  const org = pathSegment(resolveOrganizationId(opts.organizationId), "organization_id");
  const app = pathSegment(resolveApplicationId(opts.applicationId), "application_id");
  return `/organization/${org}/application/${app}${resource}`;
}

/** `/organization/{org}{resource}` — org-only console path (e.g. billing). */
export function orgPath(resource: string, opts: { organizationId?: string } = {}): string {
  return `/organization/${pathSegment(resolveOrganizationId(opts.organizationId), "organization_id")}${resource}`;
}

/**
 * Auth headers for the Didit APIs: the caller's Bearer access token (from the OAuth flow in
 * hosted mode, or DIDIT_ACCESS_TOKEN in stdio mode), or the application API key of an API key
 * connection, sent as `x-api-key` exactly as on a direct API call. The console's
 * application routes accept the application's own key; its organization-wide routes do not,
 * which is why those tools are not offered to such a connection (api-key-connection.ts).
 */
function authHeaders(): Record<string, string> {
  const ctx = requestContext.getStore();
  if (ctx?.apiKey) return { "x-api-key": ctx.apiKey };
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

/**
 * Identifies the MCP server (and the tool behind the request) to the backend. The
 * backend's audit log stores the User-Agent, so every MCP-originated action shows up
 * there attributed to its tool without any backend change.
 */
export function userAgent(): string {
  const tool = requestContext.getStore()?.toolName;

  return `didit-mcp-server/${SERVER_VERSION}${tool ? ` tool/${tool}` : ""}`;
}

/** Sent on every backend request the MCP server makes (apiRequest and the other Didit-bound fetches). */
export const AGENT_HEADER = "X-Didit-Agent";
export const AGENT_HEADER_VALUE = "mcp";

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

/** Binary bodies apiRequest returns as bytes: the content type and file signature both have to match. */
const BINARY_RESPONSES = {
  pdf: { contentType: "application/pdf", magic: Buffer.from("%PDF-", "ascii"), label: "PDF report" },
  png: { contentType: "image/png", magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), label: "PNG image" },
} as const;

export interface ApiRequestOptions {
  /** Preserve the original file bytes (PDF or PNG) instead of decoding them as text. */
  responseType?: "pdf" | "png";
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
  // X-Didit-Agent marks every request as agent-originated: the backend refuses settings changes
  // that carry it (the agent top-up switch is a person's decision). Last, so a caller cannot drop it.
  const init: RequestInit = { method, headers: { "User-Agent": userAgent(), ...resolvedHeaders, [AGENT_HEADER]: AGENT_HEADER_VALUE } };
  if (opts.responseType) {
    init.redirect = "error";
    init.signal = AbortSignal.timeout(60000);
  }
  if (form) {
    init.body = form;
  } else if (json !== undefined) {
    init.body = JSON.stringify(json);
  }

  const res = await fetch(url.toString(), init);

  if (res.ok && opts.responseType) {
    const binary = BINARY_RESPONSES[opts.responseType];
    if (res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== binary.contentType) {
      throw new Error(`Didit did not return a ${binary.label}.`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.subarray(0, binary.magic.length).equals(binary.magic)) {
      throw new Error(`Didit returned an invalid ${binary.label}.`);
    }
    return bytes;
  }

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
      hint: apiKeyRefusalHint(res.status) ?? statusToHint(res.status, body),
      field: parsed.field,
      allowed: parsed.allowed,
      status: res.status,
      ...backendAction(body),
    });
  }

  return body;
}

/**
 * A 403 on an API key connection (api-key-connection.ts) is about the key, never about a role:
 * the generic hint ("it may require a different role") would send the agent to the wrong fix.
 */
function apiKeyRefusalHint(status: number): string | undefined {
  if (status !== 403 || !requestContext.getStore()?.apiKey) return undefined;

  return (
    "This connection uses an API key. Either the key's access does not cover this action (a person widens it in the " +
    "Didit console, under the application's API keys), or the action needs a person's sign-in (the console, or an OAuth connection)."
  );
}

/**
 * A refusal the backend answers with its own machine code and a `next_step` (action, url,
 * description) - the agent top-up route does - keeps both, unchanged, so the model can hand the
 * person the console link. Bodies without them add nothing.
 */
function backendAction(body: any): {
  backend_code?: string;
  next_step?: Record<string, unknown>;
  sso_organization?: { name?: string; slug?: string };
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  // 403 `sso_required` (service-didit-auth): the account's organization enforces SSO. Its machine code
  // is under `error`, with the organization named beside it.
  if (body.error === "sso_required") {
    const text = (value: unknown) => (typeof value === "string" && value ? value.slice(0, 200) : undefined);
    const name = text(body.organization_name);
    const slug = text(body.organization_slug);
    return { backend_code: "sso_required", ...(name || slug ? { sso_organization: { name, slug } } : {}) };
  }
  const nextStep = body.next_step && typeof body.next_step === "object" && !Array.isArray(body.next_step) ? body.next_step : undefined;
  return {
    ...(typeof body.code === "string" && body.code ? { backend_code: body.code } : {}),
    ...(nextStep ? { next_step: nextStep } : {}),
  };
}

/**
 * Build a multipart/form-data body from file inputs and optional scalar fields.
 * Shared by the standalone image endpoints and branding customization. Each
 * file input is either a local absolute path (string — local/stdio runs) or a
 * FileSource ({ path?, base64? }) so hosted callers can send file content
 * inline. The record key doubles as the multipart field name and the
 * error-message parameter stem.
 */
export function buildFormData(
  files: Record<string, string | FileSource | undefined>,
  scalars: Record<string, any> = {},
): FormData {
  const form = new FormData();
  for (const [key, source] of Object.entries(files)) {
    if (!source) continue;
    const normalized: FileSource = typeof source === "string" ? { path: source } : source;
    const resolved = resolveFileSource(normalized, key);
    if (!resolved) continue;
    form.append(key, new Blob([resolved.buffer]), resolved.filename);
  }
  for (const [key, value] of Object.entries(scalars)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "string" ? value : String(value));
  }
  return form;
}

/**
 * Drop the routing ids from a tool call's arguments. They are read into
 * `requestContext` by the CallTool dispatcher before the handler runs, so by
 * the time a handler sees its args they are pure payload — which is what lets
 * every app-scoped tool ADVERTISE `organization_id` / `application_id`
 * (ORG_APP_PROPS) without the handlers that forward their args verbatim
 * leaking them into a query string or a POST body.
 */
export function stripRoutingIds(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return args as undefined;
  const { organization_id: _org, application_id: _app, ...rest } = args as Record<string, unknown>;

  return rest;
}
