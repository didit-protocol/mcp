import { apiRequest, getHeaders, orgAppPath, resolveApplicationId, resolveOrganizationId } from "../config";
import { createSessionPdfDownload } from "../session-pdf-download";
import { createSignatureDownload } from "../signature-download";
import { pathSegment, assertBoolean, assertSafeWebhookUrl, DiditError, MAX_BATCH_IDS } from "../security";
import { withoutScope } from "./compliance";

// createSession stays on the wired developer /session/ endpoint (accepts the user Bearer via
// IsValidUserOrgClient). Session LIST / bulk-delete / reviews are org/app-scoped console
// resources. Per-session detail ops (decision, update-*, generate-pdf) are FLAT /session/{id}/...
// — the console calls them flat with the user Bearer, so they are left unchanged.

const sid = (id: string) => pathSegment(id, "session_id");

export async function createSession(data: Record<string, any>): Promise<any> {
  const json = { ...data };
  // portrait_image may be a URL the backend fetches — SSRF-guard it (base64 left untouched).
  if (typeof json.portrait_image === "string" && /^https?:\/\//i.test(json.portrait_image)) {
    json.portrait_image = assertSafeWebhookUrl(json.portrait_image, "portrait_image");
  }
  return apiRequest("/session/", { method: "POST", json });
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

export async function createImport(data: Record<string, any>): Promise<any> {
  const json = { ...data };
  // The backend FETCHES source_file_url — SSRF-guard it before forwarding.
  if (typeof json.source_file_url === "string") {
    json.source_file_url = assertSafeWebhookUrl(json.source_file_url, "source_file_url");
  }
  assertProviderCredentials(json);
  return withoutCredentials(await apiRequest("/session/imports/", { method: "POST", json }));
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
  return apiRequest("/session/imports/providers/");
}

export async function checkImportProvider(data: Record<string, any>): Promise<any> {
  assertProviderCredentials(data);
  return withoutCredentials(await apiRequest("/session/imports/providers/check/", { method: "POST", json: data }));
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
    }),
  );
}

export async function getImportTemplate(): Promise<any> {
  return apiRequest("/session/imports/template/");
}

export async function getImport(importId: string): Promise<any> {
  return apiRequest(`/session/imports/${pathSegment(importId,"import_id")}/`);
}

export async function getImportErrors(importId: string): Promise<any> {
  return apiRequest(`/session/imports/${pathSegment(importId,"import_id")}/errors/`);
}
