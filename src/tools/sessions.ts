import { apiRequest, getHeaders, orgAppPath, requestContext, resolveApplicationId, resolveOrganizationId } from "../config";
import type { RegisteredTool } from "./registry";
import { PAGE_PROPS, pageParams } from "../paging";
import { DOCUMENT_TYPES, SESSION_STATUSES } from "./shared-schema";
import { searchSessions } from "./search";
// session-explain imports getSessionDecision from here: each side uses the other only inside a call.
import { explainSessionDecision } from "./session-explain";
import { ORG_APP_PROPS } from "../orgapp";
import { createSessionPdfDownload } from "../session-pdf-download";
import { createSignatureDownload } from "../signature-download";
import { pathSegment, assertBoolean, assertSafeWebhookUrl, DiditError, MAX_BATCH_IDS } from "../security";
import { withoutScope } from "./compliance";

// createSession stays on the wired developer /session/ endpoint (accepts the user Bearer via
// IsValidUserOrgClient). Session LIST / bulk-delete / reviews are org/app-scoped console
// resources. Per-session detail ops (decision, update-*, generate-pdf) are FLAT /session/{id}/...
// — the console calls them flat with the user Bearer, so they are left unchanged.

const sid = (id: string) => pathSegment(id, "session_id");

/**
 * The application a person's call acts in, as the header the flat `/session/` route reads.
 *
 * For a person's token that route takes the application from `X-Didit-Application-Id`, and only when
 * the header is absent derives it from the workflow (sdv `IsValidUserOrgClient`). Without the header,
 * a call that NAMED its application and a workflow the API cannot find (an id that does not exist, or
 * a workflow's name where its id belongs) was answered "Name the application in the
 * X-Didit-Application-Id header" with a hint about roles: a header a model cannot set, for a call
 * that had named the application. And a workflow of ANOTHER application created the session there,
 * with nothing in the answer saying so. Staging, 12 November 2026.
 *
 * With the header the API works in the application the call names, and answers about the workflow.
 * A call that names no application sends none, and the API derives it from the workflow as before.
 * An API key is its application and sends no such header.
 */
function namedApplicationHeaders(): Record<string, string> | undefined {
  const context = requestContext.getStore();
  if (!context?.accessToken || context.apiKey || !context.applicationId) return undefined;

  return { ...getHeaders(), "X-Didit-Application-Id": context.applicationId };
}

export async function createSession(data: Record<string, any>): Promise<any> {
  const json = { ...data };
  // portrait_image may be a URL the backend fetches — SSRF-guard it (base64 left untouched).
  if (typeof json.portrait_image === "string" && /^https?:\/\//i.test(json.portrait_image)) {
    json.portrait_image = assertSafeWebhookUrl(json.portrait_image, "portrait_image");
  }
  const headers = namedApplicationHeaders();
  try {
    return await apiRequest("/session/", { method: "POST", json, headers });
  } catch (error) {
    throw headers ? error : applicationNotDerived(error, json.workflow_id);
  }
}

/**
 * A call that named no application leaves the API to derive it from the workflow. When it cannot
 * (no workflow with that id that the person can use, or a name where the id belongs) the API asks
 * for the `X-Didit-Application-Id` header, which is not something a caller of this tool can send.
 * Say what the caller can do: the workflow reference is what failed.
 */
function applicationNotDerived(error: unknown, workflowId: unknown): unknown {
  if (!(error instanceof DiditError) || error.shape.status !== 403 || !/X-Didit-Application-Id/.test(error.shape.message)) return error;
  const named = typeof workflowId === "string" && workflowId.trim() !== "";

  return new DiditError({
    code: "bad_request",
    field: "workflow_id",
    message: named
      ? "No workflow you can use has this workflow_id, so the application to create the session in could not be worked out from it."
      : "workflow_id is required: it also tells which application the session is created in.",
    hint: "Pass the id of a workflow, not its name: didit_workflow_list returns the ids. To say which application to work in, pass application_id as well (didit_context_get lists the applications).",
  });
}

/**
 * The list's `count` stops at 100 (the backend's bounded COUNT): 100 means "100 or more". Asked
 * "how many sessions are in review?" on staging (2026-11-04) the console copilot read `count: 100`
 * off a one-row page and answered 100 while the console's own Needs review tab said 266.
 */
export const LIST_COUNT_CAP = 100;

/** The single list view `GET …/sessions/counts/` counts exactly for a `status` filter. */
const COUNT_VIEW_BY_STATUS: Record<string, string> = {
  "In Review": "needs_review",
  Approved: "approved",
  Declined: "declined",
};
/** `…/sessions/counts/` stops at this many; a count equal to it means at least that many. */
const VIEW_COUNT_CAP = 10_000;

export async function listSessions(params?: Record<string, string>): Promise<any> {
  const page = await apiRequest(orgAppPath("/sessions/"), { params });

  if (page?.count !== LIST_COUNT_CAP) return page;
  return { ...page, ...(await exactSessionCount(params)) };
}

/**
 * When the list's count hit its cap, the exact total from the console's own tab counts (same
 * filters, exact up to 10,000), so an agent never reports the cap as the number. A status the
 * counts cannot express alone, or a counts call that fails (429 busy, 503 timeout), keeps the
 * honest lower bound instead of failing the list.
 */
async function exactSessionCount(params?: Record<string, string>): Promise<Record<string, unknown>> {
  const { status, limit: _limit, offset: _offset, ...filters } = withoutScope(params);
  const view = status ? COUNT_VIEW_BY_STATUS[status.trim()] : "all";
  const lowerBound = {
    count_is_lower_bound: true,
    count_note: `count stops at ${LIST_COUNT_CAP}: there are at least ${LIST_COUNT_CAP} matching sessions.`,
  };

  if (!view) return lowerBound;
  try {
    // The console's own tab counts: a flat route scoped by headers, not by the path.
    const counts = await apiRequest("/sessions/counts/", {
      params: filters,
      headers: {
        ...getHeaders(),
        "X-Didit-Organization-Id": resolveOrganizationId(params?.organization_id),
        "X-Didit-Application-Id": resolveApplicationId(params?.application_id),
      },
    });
    const total = counts?.views?.[view];

    if (typeof total !== "number") return lowerBound;
    return {
      total_count: total,
      ...(total >= VIEW_COUNT_CAP
        ? {
            count_is_lower_bound: true,
            count_note: `total_count stops at ${VIEW_COUNT_CAP}: there are at least that many.`,
          }
        : {}),
    };
  } catch {
    return lowerBound;
  }
}

export async function getSessionDecision(sessionId: string): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/decision/`);
}

export async function updateSessionStatus(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/update-status/`, { method: "PATCH", json: data });
}

const SIMULATED_STATUSES = ["Approved", "Declined", "In Review", "Expired", "Abandoned"];

/**
 * Finish a SANDBOX session with a chosen outcome (POST /v3/session/{id}/simulate/), so an agent
 * can test the decision and the webhooks end to end without anyone going through the flow. The
 * backend answers 404 for a live session, so this can never decide a real verification.
 */
export async function simulateSandboxSession(sessionId: string, data: Record<string, any>): Promise<any> {
  const body: Record<string, any> = {};
  for (const key of ["new_status", "scenario", "risk", "node_id", "comment", "send_webhooks"]) {
    if (data?.[key] !== undefined) body[key] = data[key];
  }
  if (body.new_status !== undefined && !SIMULATED_STATUSES.includes(body.new_status)) {
    throw new DiditError({
      code: "bad_request",
      message: `new_status must be one of ${SIMULATED_STATUSES.join(", ")}.`,
      field: "new_status",
      allowed: SIMULATED_STATUSES,
    });
  }
  if (body.new_status === undefined && body.scenario === undefined && body.risk === undefined) {
    throw new DiditError({
      code: "bad_request",
      message: "Pass new_status, scenario or risk.",
      hint: "new_status:'Approved' finishes the session approved; scenario:'decline_aml_hit' reproduces that outcome.",
    });
  }
  try {
    return await apiRequest(`/session/${sid(sessionId)}/simulate/`, { method: "POST", json: body });
  } catch (error) {
    if (error instanceof DiditError && error.shape.status === 404) {
      throw new DiditError({
        ...error.shape,
        hint: "Only a session of a SANDBOX application can be simulated (mode 'sandbox' in didit_context_get); a live session is decided by the person who verifies.",
      });
    }
    throw error;
  }
}

export async function updateSessionData(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/update-data/`, { method: "PATCH", json: data });
}

export async function updateSessionPoaData(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/update-poa-data/`, { method: "PATCH", json: data });
}

// Session deletion is irreversible, so both delete tools demand an explicit confirm:true
// (the schema marks it required, but schema validation is client-side - enforce it here).
function assertDeleteConfirmed(confirm: unknown, what: string): void {
  assertBoolean(confirm, "confirm");
  if (confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: `${what} This permanently and irreversibly erases the session data.`,
      field: "confirm",
      hint: "Re-call with confirm:true once the user has explicitly confirmed this exact deletion.",
    });
  }
}

export async function deleteSession(sessionId: string, confirm?: unknown): Promise<any> {
  assertDeleteConfirmed(confirm, "Deleting a session requires confirm:true.");
  return apiRequest(`/session/${sid(sessionId)}/delete/`, { method: "DELETE" });
}

export async function batchDeleteSessions(
  sessionNumbers?: number[],
  deleteAll?: unknown,
  confirm?: unknown,
): Promise<any> {
  assertBoolean(deleteAll, "delete_all");
  const wildcard = deleteAll === true;
  assertDeleteConfirmed(
    confirm,
    wildcard
      ? "delete_all permanently removes EVERY KYC session in this application."
      : "Batch-deleting sessions requires confirm:true.",
  );
  if (!wildcard) {
    if (!Array.isArray(sessionNumbers) || sessionNumbers.length === 0) {
      throw new DiditError({
        code: "bad_request",
        message: "Provide a non-empty session_numbers array, or set delete_all with confirm:true.",
        field: "session_numbers",
      });
    }
    if (sessionNumbers.length > MAX_BATCH_IDS) {
      throw new DiditError({
        code: "bad_request",
        message: `Too many session_numbers (max ${MAX_BATCH_IDS} per batch).`,
        field: "session_numbers",
      });
    }
  }
  return apiRequest(orgAppPath("/sessions/delete/"), {
    method: "DELETE",
    json: { session_numbers: sessionNumbers, delete_all: wildcard },
  });
}

export async function generateSessionPdf(sessionId: string): Promise<any> {
  // Console fetches the PDF via GET /session/{id}/generate-pdf/ (trailing slash matters —
  // a slash-less path redirects and drops the auth header → 403; flat, user Bearer).
  return createSessionPdfDownload(sessionId);
}

// E-signature step files. A signed PDF, an evidence PDF and a field PNG are binary, so each tool returns a
// short-lived download link (the same capability-link design as the session PDF) and never the bytes.
export async function getSignatureEvidence(sessionId: string, nodeId: string, signatureId?: string): Promise<any> {
  return createSignatureDownload({ kind: "evidence", session_id: sessionId, node_id: nodeId, target_id: signatureId });
}

export async function getSignedDocument(sessionId: string, nodeId: string, documentId: string): Promise<any> {
  return createSignatureDownload({ kind: "document", session_id: sessionId, node_id: nodeId, target_id: documentId });
}

export async function getSignatureFieldImage(sessionId: string, nodeId: string, fieldId: string): Promise<any> {
  return createSignatureDownload({ kind: "field_image", session_id: sessionId, node_id: nodeId, target_id: fieldId });
}

export async function validateSignatures(sessionId: string, nodeId: string, signatureId?: string): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/signatures/${pathSegment(nodeId, "node_id")}/validate/`, {
    method: "POST",
    json: signatureId ? { signature_id: signatureId } : {},
  });
}

/** One page of a session's review history (50 unless `limit` says otherwise), newest first. */
export async function listSessionReviews(sessionId: string, params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/sessions/${sid(sessionId)}/reviews/`), { params });
}

export async function addSessionReview(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/sessions/${sid(sessionId)}/reviews/`), { method: "POST", json: data });
}

/** GET /geolocation/sessions/{id}/evidence/: the session page's Location section, node by
 * node (flat, user Bearer: the session in the path decides the application). Each node's
 * `map` (the console map's drawing props, which repeat the config's areas) and `map_url` (a
 * PNG path no tool can fetch) are dropped; everything else is what the reviewer reads. */
export async function getSessionLocationEvidence(sessionId: string): Promise<any> {
  const evidence = await apiRequest(`/geolocation/sessions/${sid(sessionId)}/evidence/`);
  if (!Array.isArray(evidence?.nodes)) return evidence;
  return { ...evidence, nodes: evidence.nodes.map(({ map, map_url, ...node }: Record<string, any>) => node) };
}

/** Delivery log of a session's webhooks, compacted for the model: the raw body is
 * capped (a full decision payload is several KB the diagnosis never needs) and only
 * the signing headers survive — they are what a failing endpoint is checking. */
const DELIVERY_BODY_MAX = 2048;
const DELIVERY_HEADERS = ["x-signature", "x-timestamp"];

export function compactWebhookDelivery(log: Record<string, any>): Record<string, any> {
  const { request_body, request_header, ...rest } = log;
  const body = typeof request_body === "string" ? request_body : JSON.stringify(request_body ?? "");
  const headers = Object.fromEntries(
    Object.entries(parseHeaders(request_header)).filter(([k]) => DELIVERY_HEADERS.includes(k.toLowerCase())),
  );

  return {
    ...rest,
    request_headers: headers,
    request_body: body.length > DELIVERY_BODY_MAX ? `${body.slice(0, DELIVERY_BODY_MAX)}… [truncated]` : body,
  };
}

function parseHeaders(raw: unknown): Record<string, string> {
  const parsed = typeof raw === "string" ? tryParse(raw) : raw;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Overridable so tests need not sleep for real; never below 250 ms so a bad value
// cannot turn the wait into a tight loop against the API.
const WEBHOOK_POLL_MS = Math.max(Number(process.env.MCP_WEBHOOK_POLL_MS) || 3000, 250);
const WEBHOOK_WAIT_MAX_S = 60;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchDeliveries(sessionId: string): Promise<Record<string, any>[]> {
  const logs = await apiRequest(`/session/${sid(sessionId)}/webhooks/`);
  return Array.isArray(logs) ? logs : [];
}

/** GET /session/{id}/webhooks/ — with `waitSeconds` the call keeps polling until at
 * least one delivery is recorded (a sandbox session fires its webhook within seconds),
 * so the model needs one call instead of a retry loop that burns its step budget. */
export async function listSessionWebhooks(sessionId: string, waitSeconds = 0): Promise<any> {
  const started = Date.now();
  const deadline = started + Math.min(Math.max(waitSeconds, 0), WEBHOOK_WAIT_MAX_S) * 1000;
  let deliveries = await fetchDeliveries(sessionId);

  while (deliveries.length === 0 && Date.now() < deadline) {
    await sleep(Math.min(WEBHOOK_POLL_MS, deadline - Date.now()));
    deliveries = await fetchDeliveries(sessionId);
  }

  return { deliveries: deliveries.map(compactWebhookDelivery), waited_seconds: Math.round((Date.now() - started) / 1000) };
}

/** POST /session/{id}/webhook/{uuid}/resend — the backend route has NO trailing slash. */
export async function resendSessionWebhook(sessionId: string, webhookId: string): Promise<any> {
  return compactWebhookDelivery(
    await apiRequest(`/session/${sid(sessionId)}/webhook/${pathSegment(webhookId, "webhook_id")}/resend`, { method: "POST" }),
  );
}

export async function shareSession(sessionId: string, data: Record<string, any>): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/share/`, { method: "POST", json: data });
}

export async function importSharedSession(data: Record<string, any>): Promise<any> {
  return apiRequest("/session/import-shared/", { method: "POST", json: data });
}

/**
 * The scope of a person's call to a session import route, as the headers that route reads.
 *
 * The import routes are flat (`/session/imports/...`). For a person's token the API takes the
 * organization from `X-Didit-Organization-Id` and the application from `X-Didit-Application-Id`,
 * and refuses the call when it cannot tell them (organization_required, application_required):
 * every import call people made in production on 12 November 2026 was refused that way. Resolved
 * like any scoped call, so a person with several applications who names none is told which ones
 * they have. An API key is its application and sends neither.
 */
function importScopeHeaders(): Record<string, string> | undefined {
  const context = requestContext.getStore();
  if (!context?.accessToken || context.apiKey) return undefined;
  return {
    ...getHeaders(),
    "X-Didit-Organization-Id": pathSegment(resolveOrganizationId(), "organization_id"),
    "X-Didit-Application-Id": pathSegment(resolveApplicationId(), "application_id"),
  };
}

export async function createImport(data: Record<string, any>): Promise<any> {
  const json = { ...data };
  // The backend FETCHES source_file_url — SSRF-guard it before forwarding.
  if (typeof json.source_file_url === "string") {
    json.source_file_url = assertSafeWebhookUrl(json.source_file_url, "source_file_url");
  }
  assertProviderCredentials(json);
  return withoutCredentials(await apiRequest("/session/imports/", { method: "POST", json, headers: importScopeHeaders() }));
}

/**
 * A provider migration carries the customer's read-only key for the OTHER provider. It goes to Didit
 * in the request body and nowhere else: the audit log records argument keys and a digest only, the
 * error redaction drops `credentials` keys, and a response is stripped of the key even though the
 * API never returns it.
 */
function assertProviderCredentials(json: Record<string, any>): void {
  if (json.source === "provider" && !json.provider) {
    throw new DiditError({ code: "bad_request", message: "provider is required when source is provider.", field: "provider" });
  }
  const credentials = json.credentials;
  if (credentials === undefined) return;
  const isStringMap = credentials !== null && typeof credentials === "object" && !Array.isArray(credentials) &&
    Object.values(credentials).every((value) => typeof value === "string");
  if (!isStringMap) {
    throw new DiditError({
      code: "bad_request",
      message: "credentials must be an object of string values named as the provider's credential_fields.",
      field: "credentials",
      hint: "Call didit_session_list_import_providers for each provider's credential_fields.",
    });
  }
}

function withoutCredentials(body: any): any {
  if (body && typeof body === "object" && !Array.isArray(body) && "credentials" in body) {
    const { credentials: _credentials, ...rest } = body;
    return rest;
  }
  return body;
}

export async function listImportProviders(): Promise<any> {
  return apiRequest("/session/imports/providers/", { headers: importScopeHeaders() });
}

export async function checkImportProvider(data: Record<string, any>): Promise<any> {
  assertProviderCredentials(data);
  return withoutCredentials(await apiRequest("/session/imports/providers/check/", { method: "POST", json: data, headers: importScopeHeaders() }));
}

const IMPORT_ACTIONS = ["start", "pause", "resume", "cancel", "retry"] as const;

export async function manageImport(importId: string, action: unknown, data: Record<string, any> = {}): Promise<any> {
  if (typeof action !== "string" || !(IMPORT_ACTIONS as readonly string[]).includes(action)) {
    throw new DiditError({
      code: "bad_request",
      message: `action must be one of ${IMPORT_ACTIONS.join(", ")}.`,
      field: "action",
      allowed: [...IMPORT_ACTIONS],
    });
  }
  assertProviderCredentials(data);
  const body = action === "start" || action === "retry" ? data : undefined;
  return withoutCredentials(
    await apiRequest(`/session/imports/${pathSegment(importId, "import_id")}/${pathSegment(action, "action")}/`, {
      method: "POST",
      json: body ?? {},
      headers: importScopeHeaders(),
    }),
  );
}

export async function getImportTemplate(): Promise<any> {
  return apiRequest("/session/imports/template/", { headers: importScopeHeaders() });
}

export async function getImport(importId: string): Promise<any> {
  return apiRequest(`/session/imports/${pathSegment(importId, "import_id")}/`, { headers: importScopeHeaders() });
}

export async function getImportErrors(importId: string): Promise<any> {
  return apiRequest(`/session/imports/${pathSegment(importId, "import_id")}/errors/`, { headers: importScopeHeaders() });
}


// The interface languages a session can be created in.
const LANGUAGE_CODES = [
  "en", "ar", "bg", "bn", "bs", "ca", "cnr", "cs", "da", "de", "el", "es", "et",
  "fa", "fi", "fr", "he", "hi", "hr", "hu", "hy", "id", "it", "ja", "ka", "kk",
  "ko", "ky", "lt", "lv", "mk", "mn", "ms", "nl", "no", "pl", "pt-BR", "pt",
  "ro", "ru", "sk", "sl", "so", "sq", "sr", "sv", "th", "tr", "uk", "uz",
  "vi", "zh-CN", "zh-TW", "zh",
];

// ── The session tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const SESSION_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_session_create",
      description: "Create a verification session. Requires workflow_id (created in the Console Workflows page) — the workflow defines which steps run and whether the session is KYC or KYB. Returns session_id, url, and session_token.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_id: { type: "string", description: "REQUIRED. The STABLE workflow_id (`workflow_id` of didit_workflow_search/list) of the workflow that defines the verification steps; runs its live version. A version uuid pins that one version and ignores later publishes. Selects KYC vs KYB implicitly." },
          vendor_data: { type: "string", description: "Your unique identifier for the user (e.g. user ID). Used to group sessions into a user/business." },
          callback: { type: "string", description: "URL to redirect the user to after verification" },
          callback_method: { type: "string", enum: ["initiator", "completer", "both"], description: "Which device/flow the callback applies to" },
          language: { type: "string", enum: LANGUAGE_CODES, description: "Pre-set the verification UI language (ISO code)" },
          sandbox_scenario: { type: "string", description: "SANDBOX ONLY (an application whose mode is 'sandbox' — see didit_context_get): predefine the outcome instead of running real providers, so the session is never billed. Slugs are 'approve', 'decline_*' (e.g. decline_aml_hit, decline_document_expired, decline_kyb_registry_mismatch) and 'review_*' (e.g. review_aml_possible_match). Ignored by a live application, where every session IS billed." },
          metadata: { type: "object", description: "Arbitrary JSON stored on the session and echoed in webhooks" },
          contact_details: { type: "object", description: "Pre-fill contact info (e.g. email, phone) for the session" },
          expected_details: { type: "object", description: "Expected values to validate against (e.g. expected country, IP)" },
          portrait_image: { type: "string", description: "Base64 or URL reference portrait for Biometric Authentication / Face-Match-first workflows. Optional when the vendor_data user already has a stored face (approved liveness face, ePassport photo, document portrait, or enrolled profile face) - the stored face is reused automatically; 400 if neither is available" },
        },
        required: ["workflow_id"],
      },
    },
    access: "write",
    permission: null, // POST /session/ → session.py:152 — permission classes only, no decorator
    run: (args) => createSession(args),
  },
  {
    def: {
      name: "didit_session_list",
      description: `List verification sessions for ONE app. If you have multiple apps (or pass no scope) this automatically spans every app, newest first - but didit_session_search is the canonical cross-app tool and what to reach for to answer "my last N sessions". status accepts session-level values: ${SESSION_STATUSES}. HOW MANY: \`count\` stops at 100 (100 means "100 or more"); when it does, the result adds \`total_count\` (the exact number, from the console's own tab counts) or \`count_is_lower_bound: true\`. Answer "how many" from total_count, never report 100 as the number; limit:1 is enough to count.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          status: { type: "string", description: `Filter by session status (${SESSION_STATUSES}). Several statuses separated by commas match any of them, e.g. "Not Started,In Progress".` },
          session_kind: { type: "string", enum: ["user", "business", "all"], description: "KYC (user), KYB (business), or all" },
          vendor_data: { type: "string", description: "Filter by vendor_data" },
          workflow_id: { type: "string", description: "Filter by workflow UUID" },
          search: { type: "string", description: "Free-text search" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          limit: { type: "string", description: "Page size (LimitOffset pagination)" },
          offset: { type: "string", description: "Pagination offset" },
        },
      },
    },
    // With no application named, it lists the sessions of every application of the organization.
    access: "read",
    permission: "list:sessions", // GET …/sessions/ → application.py:123
    spanAllApplications: (args) => searchSessions(args),
    run: (args) => listSessions(args),
  },
  {
    def: {
      name: "didit_session_get_decision",
      description: "Get the full verification decision and all extracted data for a session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Session UUID" },
        },
        required: ["session_id"],
      },
    },
    access: "read",
    permission: "read:sessions", // GET /session/{id}/decision/ → session.py:536
    run: (args) => getSessionDecision(args.session_id),
  },
  {
    def: {
      name: "didit_session_get_location_evidence",
      description: "Precise Location (GEOLOCATION) evidence of ONE session, per Location node: `config` (what judged it, every action resolved through the preset), `result` (the decision's verdict), EVERY attempt incl. retired ones (`retired:true`), `reference_points` (device, IP, address; `area_reading` is the earlier attempt a carried area verdict stands on), `distances`, `areas` (inside / blocked / undetermined area ids, `nearest_allowed_km`, `allowed_result`), `anonymizers` (vpn, proxy, tor, spoofing, emulator; null = cannot tell) and `history`: the same person's earlier checks (same vendor_data) that LOCATION_CONSECUTIVE_MISMATCHES and travel tolerance are judged from. The decision keeps only the accepted attempt: use this for 'which attempt was outside', 'why consecutive mismatches' or 'why was the distance excused'. Holds precise coordinates: quote only what the question needs. `nodes: []` means no Location attempt was recorded; a 404 'Precise Location is not available.' means the feature is off on this deployment.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Session UUID" },
        },
        required: ["session_id"],
      },
    },
    access: "read",
    permission: "read:sessions", // GET /geolocation/sessions/{id}/evidence/ → geolocation/views/console.py:53
    run: (args) => getSessionLocationEvidence(args.session_id),
  },
  {
    def: {
      name: "didit_session_simulate",
      description:
        "SANDBOX ONLY: finish a session of a sandbox application (mode 'sandbox' in didit_context_get) with the " +
        "outcome you pick, without anyone going through the verification flow, then read it with " +
        "didit_session_get_decision and its webhooks with didit_session_webhooks. Never billed. Pass new_status " +
        "('Approved', 'Declined', 'In Review', 'Expired', 'Abandoned'), a scenario slug ('approve', 'decline_aml_hit', " +
        "'decline_document_expired', 'review_aml_possible_match', ...) or a risk. A live session answers not found.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string", description: "REQUIRED. A session of a sandbox application." },
          new_status: { type: "string", enum: ["Approved", "Declined", "In Review", "Expired", "Abandoned"] },
          scenario: { type: "string", description: "Sandbox scenario slug whose outcome to reproduce." },
          risk: { type: "string", description: "A risk case to add as a warning." },
          comment: { type: "string", description: "Note on the activity entry." },
          send_webhooks: { type: "boolean", description: "Send the webhooks a real status change sends (default true)." },
        },
        required: ["session_id"],
      },
    },
    access: "write",
    permission: "write:sessions", // POST /session/{id}/simulate/ → sandbox simulate (sandbox sessions only)
    run: ({ session_id, ...data }) => simulateSandboxSession(session_id, data),
  },
  {
    def: {
      name: "didit_session_update_status",
      description: "Overwrite a session's decision by approving, declining, or requesting resubmission; optionally send a notification email that cannot be recalled. Before calling, obtain explicit user confirmation of the session, new decision, and any email recipient. For resubmission, pass new_status='Resubmitted' and nodes_to_resubmit; already-approved steps are kept.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          new_status: { type: "string", enum: ["Approved", "Declined", "Resubmitted"], description: "New decision status" },
          comment: { type: "string", description: "Reviewer note stored on the audit trail" },
          nodes_to_resubmit: { type: "array", items: { type: "string" }, description: "Node IDs the user must redo (only for Resubmitted)" },
          send_email: { type: "boolean", description: "Send a notification email that cannot be recalled. Set true only after explicit user confirmation of the notification and recipient." },
          email_address: { type: "string", description: "Override the notification recipient; confirm this address with the user before sending." },
          email_language: { type: "string", description: "Language for the notification email" },
        },
        required: ["session_id", "new_status"],
      },
    },
    // A consequential decision (approve, decline), and it can reach outside the workspace.
    access: "destructive",
    openWorld: true,
    permission: "write:sessions", // PATCH /session/{id}/update-status/ → session.py:1033
    run: ({ session_id, ...data }) => updateSessionStatus(session_id, data),
  },
  {
    def: {
      name: "didit_session_update_data",
      description: "Correct the KYC data extracted from the ID document on a session (reviewer override). Only send the fields you want to change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          document_type: { type: "string", enum: DOCUMENT_TYPES },
          document_subtype: { type: "string" },
          document_number: { type: "string" },
          personal_number: { type: "string" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD" },
          date_of_issue: { type: "string", description: "YYYY-MM-DD" },
          expiration_date: { type: "string", description: "YYYY-MM-DD" },
          issuing_state: { type: "string", description: "ISO 3166-1 alpha-3 issuing country" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          gender: { type: "string", enum: ["M", "F", "U"] },
          address: { type: "string" },
          place_of_birth: { type: "string" },
          nationality: { type: "string" },
          marital_status: { type: "string", enum: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "UNKNOWN"] },
          extra_fields: { type: "object", description: "Document-specific extra fields" },
          parsed_address: { type: "object", description: "Structured address override" },
        },
        required: ["session_id"],
      },
    },
    access: "write",
    permission: "write:sessions", // PATCH /session/{id}/update-data/ → session.py:1238
    run: ({ session_id, ...data }) => updateSessionData(session_id, data),
  },
  {
    def: {
      name: "didit_session_update_poa_data",
      description: "Correct the Proof of Address data extracted from the POA document on a session (reviewer override). Only send the fields you want to change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          issuing_state: { type: "string", description: "ISO 3166-1 alpha-3 issuing country" },
          document_type: { type: "string", enum: ["UTILITY_BILL", "BANK_STATEMENT", "GOVERNMENT_ISSUED_DOCUMENT", "OTHER_POA_DOCUMENT", "UNKNOWN"] },
          document_language: { type: "string" },
          issuer: { type: "string" },
          issue_date: { type: "string", description: "YYYY-MM-DD" },
          poa_address: { type: "string" },
          name_on_document: { type: "string" },
          extra_fields: { type: "object" },
          poa_parsed_address: { type: "object", description: "Structured address override" },
        },
        required: ["session_id"],
      },
    },
    access: "write",
    permission: "write:sessions", // PATCH /session/{id}/update-poa-data/ → session.py:1461
    run: ({ session_id, ...data }) => updateSessionPoaData(session_id, data),
  },
  {
    def: {
      name: "didit_session_delete",
      description: "Permanently and irreversibly delete a single verification session (KYC or KYB) - its verification data and stored media. Blocklist entries, issued share tokens, already-queued webhook deliveries, consumed credits, and the parent user/business are not affected. Requires confirm:true - only pass it after the user has explicitly confirmed this exact deletion.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          confirm: { type: "boolean", description: "REQUIRED. Must be true - deletion is permanent and irreversible. Only set after explicit user confirmation of this exact action." },
        },
        required: ["session_id", "confirm"],
      },
    },
    access: "destructive",
    permission: "delete:sessions", // DELETE /session/{id}/delete/ → session.py:1406
    run: (args) => deleteSession(args.session_id, args.confirm),
  },
  {
    def: {
      name: "didit_session_batch_delete",
      description: "Permanently and irreversibly delete multiple KYC sessions by session number, or EVERY KYC session in the application with delete_all:true (KYB sessions are never touched; delete those individually). Requires confirm:true - only pass it after the user has explicitly confirmed this exact deletion.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_numbers: {
            type: "array",
            items: { type: "number" },
            description: "Array of session numbers to delete",
          },
          delete_all: { type: "boolean", description: "Set true to delete ALL sessions (ignores session_numbers)" },
          confirm: { type: "boolean", description: "REQUIRED. Must be true - deletion is permanent and irreversible. Only set after explicit user confirmation of this exact action." },
        },
        required: ["confirm"],
      },
    },
    access: "destructive",
    permission: "delete:sessions", // DELETE …/sessions/delete/ → application.py:529
    run: (args) => batchDeleteSessions(args.session_numbers, args.delete_all, args.confirm),
  },
  {
    def: {
      name: "didit_session_generate_pdf",
      description: "Return download_url, expires_at and expires_in (300 seconds) for the original Didit session PDF. Fetch the URL to save the PDF; no Authorization header is needed. Treat the URL as sensitive. Requires configured MCP HTTP PDF downloads.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string" },
        },
        required: ["session_id"],
      },
    },
    // Its name reads like a read, but its handler creates a server-side artifact or job.
    access: "write",
    permission: "read:sessions", // GET /session/{id}/generate-pdf/ → pdf.py:86
    run: (args) => generateSessionPdf(args.session_id),
  },
  {
    def: {
      name: "didit_session_get_signature_evidence",
      description:
        "Return download_url, content_type, expires_at and expires_in (300 seconds) for a signer's evidence PDF of an E-signature step: level and format, " +
        "signer, IP address, each document with its original SHA-256 and field values and the SHA-256 of every signed file, plus, for an Advanced (AES) " +
        "signature, the verified identity session, the code confirmation, the certificate and the timestamp. Pass the evidence_file path's signer as " +
        "signature_id; a Business Verification step with several signers needs it, otherwise the route picks one. Fetch the URL to save the PDF; no " +
        "Authorization header is needed. Treat the URL as sensitive. Requires configured MCP HTTP downloads (see the README).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string", description: "REQUIRED. The User Verification (KYC) or Business Verification (KYB) session." },
          node_id: { type: "string", description: "REQUIRED. The E-signature step: node_id of the item in the decision's signatures[]." },
          signature_id: { type: "string", description: "id of the signer's item in signatures[]. Required to pick a signer on a Business Verification step with several." },
        },
        required: ["session_id", "node_id"],
      },
    },
    // Its name reads like a read, but its handler creates a server-side artifact or job.
    access: "write",
    permission: "read:sessions", // GET /session/{id}/signatures/{node}/evidence/ → signatures/downloads.py:78
    run: (args) => getSignatureEvidence(args.session_id, args.node_id, args.signature_id),
  },
  {
    def: {
      name: "didit_session_get_signed_document",
      description:
        "Return download_url, content_type, expires_at and expires_in (300 seconds) for the signed PDF of one document of an E-signature step: the document the " +
        "signer was shown with their field values stamped and the evidence page (unless signature_evidence_page is off). An Advanced (AES) PDF also carries the " +
        "PAdES signature with its timestamp; a Simple PDF has no digital signature, seal or timestamp. Didit checks the file against sha256_signed first (409 on a " +
        "mismatch, nothing returned). Use the id of the document in signatures[].documents[]. Treat the URL as sensitive. Requires configured MCP HTTP downloads.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string", description: "REQUIRED. The User Verification (KYC) or Business Verification (KYB) session." },
          node_id: { type: "string", description: "REQUIRED. The E-signature step: node_id of the item in the decision's signatures[]." },
          document_id: { type: "string", description: "REQUIRED. id of the document in signatures[].documents[]." },
        },
        required: ["session_id", "node_id", "document_id"],
      },
    },
    // Its name reads like a read, but its handler creates a server-side artifact or job.
    access: "write",
    permission: "read:sessions", // GET …/signatures/{node}/documents/{doc}/file/ → same view
    run: (args) => getSignedDocument(args.session_id, args.node_id, args.document_id),
  },
  {
    def: {
      name: "didit_session_get_signature_field_image",
      description:
        "Return download_url, content_type (image/png), expires_at and expires_in (300 seconds) for the signature or initials a signer applied to a field. " +
        "Use the field id from the image_url of signatures[].documents[].fields[]. Treat the URL as sensitive. Requires configured MCP HTTP downloads.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string", description: "REQUIRED. The User Verification (KYC) or Business Verification (KYB) session." },
          node_id: { type: "string", description: "REQUIRED. The E-signature step: node_id of the item in the decision's signatures[]." },
          field_id: { type: "string", description: "REQUIRED. The field on this signer's copy, as in the field's image_url." },
        },
        required: ["session_id", "node_id", "field_id"],
      },
    },
    // Its name reads like a read, but its handler creates a server-side artifact or job.
    access: "write",
    permission: "read:sessions", // GET …/signatures/{node}/fields/{field}/image/ → same view
    run: (args) => getSignatureFieldImage(args.session_id, args.node_id, args.field_id),
  },
  {
    def: {
      name: "didit_session_validate_signatures",
      description:
        "Re-check the signed documents of an E-signature step and save the result in each signer's validation. Didit re-reads every signed PDF, checks its " +
        "SHA-256 and, for an Advanced (AES) signature, validates the PAdES signature, the certificate, the revocation data and the timestamp (a Simple signature " +
        "has no digital signature, so only file integrity is checked). Nothing is signed again. Without signature_id every signer of the step is checked and the " +
        "call fails with 409 if any has not signed; 400 means a stored signed PDF no longer matches its recorded SHA-256. Returns the checked signers.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string", description: "REQUIRED. The User Verification (KYC) or Business Verification (KYB) session." },
          node_id: { type: "string", description: "REQUIRED. The E-signature step: node_id of the item in the decision's signatures[]." },
          signature_id: { type: "string", description: "id of one signer's item in signatures[]; omit to check every signer of the step." },
        },
        required: ["session_id", "node_id"],
      },
    },
    // Its name reads like a read, but its handler creates a server-side artifact or job.
    access: "write",
    permission: "write:sessions", // POST …/signatures/{node}/validate/ → signatures/downloads.py:99
    run: (args) => validateSignatures(args.session_id, args.node_id, args.signature_id),
  },
  {
    def: {
      name: "didit_session_list_reviews",
      description: "List the review history and activity log for a session, newest first. One page: 50 entries unless `limit` says otherwise, with `count` as the total and `offset` to read the ones after.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string" },
          ...PAGE_PROPS,
        },
        required: ["session_id"],
      },
    },
    access: "read",
    permission: "read:sessions", // GET …/sessions/{id}/reviews/ → activity.py:77
    run: (args) => listSessionReviews(args.session_id, pageParams(args)),
  },
  {
    def: {
      name: "didit_session_add_review",
      description: "Add a review note to a session's audit trail, optionally changing its status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string" },
          comment: { type: "string", description: "Review comment or note" },
          new_status: {
            type: "string",
            enum: ["Not Started", "In Progress", "Approved", "Declined", "In Review", "Expired", "Abandoned", "Kyc Expired", "Resubmitted", "Awaiting User"],
            description: "Optional new session status to record with the note",
          },
        },
        required: ["session_id"],
      },
    },
    access: "write",
    permission: "write:sessions", // POST …/sessions/{id}/reviews/ → activity.py:97
    run: ({ session_id, ...data }) => addSessionReview(session_id, data),
  },
  {
    def: {
      name: "didit_session_share",
      description: "Share a verified session with a trusted partner for reusable KYC (B2B session sharing).",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          partner_client_id: { type: "string", description: "The partner application's client_id" },
        },
        required: ["session_id", "partner_client_id"],
      },
    },
    // Shares verification data with a partner.
    access: "write",
    openWorld: true,
    permission: "write:sessions", // POST /session/{id}/share/ → shared_session.py:44
    run: (args) => shareSession(args.session_id, args),
  },
  {
    def: {
      name: "didit_session_explain_decision",
      description: "WHY a verification session ended Approved / Declined / In Review, as a deterministic trace read from the record: the feature that decided it (strictest wins), each warning that had an effect with its raw value, every triggered status rule (field, operator, configured vs actual value), the human override if a reviewer changed the automatic verdict, and for each cause the workflow config key that governs it (`lever`, with its CURRENT value read from the workflow graph; only keys that exist in the feature-config contract; null means it is not a workflow setting). `workflow.graph_read:false` means the graph could not be read, so no current values. Use this for every 'why was it declined / in review / approved', 'it should have been X' and 'how do I make these go to X' question INSTEAD of reading the whole decision — it never returns images, extracted fields or PII. `informational` lists warnings that changed nothing. `unexplained:true` means a decided session (Declined / In Review) whose record shows no effective cause (e.g. minimized age-assurance logs): say so, never invent one. `lifecycle_status:true` (Expired, Abandoned, Not Started, In Progress, Resub Requested…) means nothing decided it — the status is the whole explanation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "REQUIRED. The session uuid (from the page's session-id param, didit_session_search or the user)" },
        },
        required: ["session_id"],
      },
    },
    // Folds a session's decision payload and its workflow graph into the outcome trace.
    access: "read",
    permission: "read:sessions", // GET /session/{id}/decision/ folded into its trace
    run: (args) => explainSessionDecision(args.session_id),
  },
  {
    def: {
      name: "didit_session_webhooks",
      description: "Delivery log of the webhooks Didit sent for ONE session (last 30 days): destination URL, HTTP response status, timing, signing headers (X-Signature/X-Timestamp) and a capped copy of the payload. The way to check an integration end to end: create a session on a SANDBOX application with sandbox_scenario 'approve' (unbilled, fires status.updated immediately), then call this with wait_seconds so the call waits for the delivery instead of you polling. A 2xx response_status means the customer's endpoint received it; 401/403 usually means their signature check (must be HMAC-SHA256 hex of the RAW body); an empty list after the wait means the endpoint never got the event (not public, or the destination is disabled).",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "REQUIRED. The session whose deliveries to read" },
          wait_seconds: { type: "integer", minimum: 0, maximum: 60, description: "Keep polling up to this many seconds until at least one delivery exists (0 = read once). Use 30-45 right after creating a sandbox session." },
        },
        required: ["session_id"],
      },
    },
    // The per-session webhook delivery log (its only verb-like token is "webhooks").
    access: "read",
    permission: "read:sessions", // GET /session/{id}/webhooks/ → webhooks.py:38
    run: (args) => listSessionWebhooks(args.session_id, Number(args.wait_seconds ?? 0)),
  },
  {
    def: {
      name: "didit_session_webhook_resend",
      description: "Resend one recorded webhook delivery of a session to the configured endpoint (the session page's own Resend). Use after the customer fixed their endpoint so they do not need a new session; returns the new delivery with its response_status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "REQUIRED" },
          webhook_id: { type: "string", description: "REQUIRED. The delivery's uuid from didit_session_webhooks" },
        },
        required: ["session_id", "webhook_id"],
      },
    },
    // Its name reads like a read, but its handler creates a server-side artifact or job.
    access: "write",
    permission: "create:sessions", // POST /session/{id}/webhook/{uuid}/resend → webhooks.py:109
    run: (args) => resendSessionWebhook(args.session_id, args.webhook_id),
  },
  {
    def: {
      name: "didit_session_import_shared",
      description: "Import a shared verification session from a partner (Reusable KYC).",
      inputSchema: {
        type: "object" as const,
        properties: {
          share_token: { type: "string", description: "Token received from the sharing partner" },
        },
        required: ["share_token"],
      },
    },
    access: "write",
    permission: null, // POST /session/import-shared/ → shared_session.py:78 — no decorator
    run: (args) => importSharedSession(args),
  },
];

// ── The session import tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const SESSION_IMPORT_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_session_create_import",
      description:
        "Create a bulk import job: a hosted CSV/NDJSON file (source_file_url) of historical verifications, or (source=provider) a migration from another " +
        "identity verification provider. File imports use Didit's canonical schema; label a record's source with the optional per-row `provider` column in the " +
        "file. A provider migration reads Sumsub, Onfido, Persona and ComplyCube with the customer's READ-ONLY key (`credentials`, named as that provider's " +
        "credential_fields from didit_session_list_import_providers); Veriff, iDenfy and MetaMap are read by the record IDs in source_file_url, and the others import " +
        "an export file. The key is secret: ask the user for a read-only key, never log or repeat it, and never reuse it. Didit encrypts it, never returns it and " +
        "erases it when the import ends. Prefer dry_run:true first: it counts what would import and writes nothing, ends READY, and didit_session_manage_import " +
        "action=start then imports for real. Record IDs are namespaced by provider, so re-runs and moving between a file and a provider migration never import a " +
        "record twice. An application runs at most 4 active import jobs at once (a fifth answers 429); a job a deploy interrupted resumes by itself. Imports must be " +
        "enabled for the organization by Didit and are refused on a sandbox application (403).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          source_file_url: { type: "string", description: "Publicly fetchable HTTPS URL of the CSV/NDJSON file (or, for providers read by record IDs, of the ID list) to import." },
          import_type: { type: "string", enum: ["user_verification", "business_verification", "status_rules", "transactions"], description: "What the rows represent (default user_verification)" },
          source_format: { type: "string", enum: ["csv", "ndjson"], description: "File format (default: inferred from the URL)" },
          workflow_id: { type: "string", description: "Workflow to associate imported sessions with" },
          source: { type: "string", enum: ["file", "provider"], description: "provider makes this a migration from another provider. Omit for a file import." },
          provider: { type: "string", description: "Migration source id from didit_session_list_import_providers (for example sumsub, onfido, persona). Required when source is provider." },
          credentials: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "SECRET. The provider's read-only key, with the field names its credential_fields list. Never echo it back to the user or into logs.",
          },
          options: { type: "object", description: "Provider options, for example { region } (Onfido: eu, us, ca)." },
          status_mapping: {
            type: "object",
            additionalProperties: { type: "string", enum: ["Approved", "Declined", "In Review", "Expired", "Not Finished", "Abandoned"] },
            description: "Edits to the provider's default status mapping: source status to Didit status. Not Finished and Abandoned are skipped and counted, never imported.",
          },
          dry_run: { type: "boolean", description: "Count what a provider migration would import and write nothing; the job ends READY and is started with didit_session_manage_import." },
          face_templates: { type: "boolean", description: "Build face templates from imported selfies and search them against the application's faces and blocklist (flags for review only). Requires lawful_basis_confirmed." },
          lawful_basis_confirmed: { type: "boolean", description: "Confirms the customer has a lawful basis to share these selfies with Didit as processor. Only set it after the user states so." },
        },
        required: ["source_file_url"],
      },
    },
    access: "write",
    permission: null, // POST /session/imports/ → imports.py:77 — no decorator
    run: (args) => createImport(args),
  },
  {
    def: {
      name: "didit_session_list_import_providers",
      description: "List the 15 providers verifications can be migrated from: what each needs to connect (credential_fields, regions), whether its API can list records, the permissions its read-only key needs and its default status mapping.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    access: "read",
    permission: null, // GET /session/imports/providers/ → import_jobs.py:99 — no decorator
    run: () => listImportProviders(),
  },
  {
    def: {
      name: "didit_session_check_import_provider",
      description:
        "Read a provider with the customer's read-only key before creating a migration. Nothing is stored. For providers read by record IDs, pass record_ids " +
        "(the first record ID of the export). The key is secret: never log or repeat it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          provider: { type: "string", description: "REQUIRED. Provider id from didit_session_list_import_providers." },
          credentials: { type: "object", additionalProperties: { type: "string" }, description: "REQUIRED. SECRET. The provider's read-only key, named as its credential_fields." },
          options: { type: "object", description: "Provider options, for example { region }." },
          record_ids: { type: "array", items: { type: "string" }, description: "For providers read by record IDs: the first record ID of the export." },
        },
        required: ["provider", "credentials"],
      },
    },
    // Reads the provider the sessions come from, with the customer's key; nothing is stored.
    access: "write",
    openWorld: true,
    permission: null, // POST /session/imports/providers/check/ → import_jobs.py:120 — no decorator
    run: (args) => checkImportProvider(args),
  },
  {
    def: {
      name: "didit_session_manage_import",
      description:
        "Act on an import job: start (a dry run that ended READY imports for real, with the status_mapping, face_templates and lawful_basis_confirmed sent now), " +
        "pause, resume, cancel (what was imported stays; the uploaded file and the key are erased) or retry (runs an ended migration again as a NEW job with a new key " +
        "in credentials, since the old one was erased; everything already in Didit is skipped).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          import_id: { type: "string", description: "REQUIRED. Import job ID." },
          action: { type: "string", enum: ["start", "pause", "resume", "cancel", "retry"], description: "REQUIRED." },
          data: {
            type: "object",
            description: "start: { status_mapping, face_templates, lawful_basis_confirmed }. retry: { credentials } (SECRET, never echo it). Other actions take none.",
          },
        },
        required: ["import_id", "action"],
      },
    },
    // Its name reads like a read, but it starts, pauses, resumes, cancels or retries an import.
    access: "write",
    permission: null, // POST /session/imports/{id}/{start|pause|resume|cancel|retry}/ → import_jobs.py — no decorator
    run: (args) => manageImport(args.import_id, args.action, args.data),
  },
  {
    def: {
      name: "didit_session_get_import_template",
      description: "Download the canonical import template (column headers and format) used by didit_session_create_import.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    access: "read",
    permission: null, // GET /session/imports/template/ → imports.py:197 — no decorator
    run: () => getImportTemplate(),
  },
  {
    def: {
      name: "didit_session_get_import",
      description: "Get the status and summary of a bulk import job.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          import_id: { type: "string", description: "Import job ID returned by didit_session_create_import" },
        },
        required: ["import_id"],
      },
    },
    access: "read",
    permission: null, // GET /session/imports/{id}/ → imports.py:170 — no decorator
    run: (args) => getImport(args.import_id),
  },
  {
    def: {
      name: "didit_session_get_import_errors",
      description: "List per-row errors for a bulk import job (rows that failed validation or processing).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          import_id: { type: "string", description: "Import job ID" },
        },
        required: ["import_id"],
      },
    },
    access: "read",
    permission: null, // GET /session/imports/{id}/errors/ → imports.py:182 — no decorator
    run: (args) => getImportErrors(args.import_id),
  },
];
