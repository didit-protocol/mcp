/**
 * Events pushed by the Didit backend, for Wakeshift.
 *
 * The backend tells this server the moment something an agent may be waiting on
 * happens (a session's status changes, a webhook delivery is logged, an import
 * job finishes, a transaction's status changes) with a signed POST to
 * /internal/events/<event>. The server verifies it, validates the body and emits
 * the matching Wakeshift event (wakeshift.ts). It never polls Didit's API.
 *
 * Requests are signed with Standard Webhooks (https://www.standardwebhooks.com/)
 * using DIDIT_EVENTS_SECRET. See docs/backend-events.md, the backend's guide.
 *
 * This module has no Wakeshift dependency: the handler takes the emit as a function.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** The largest body accepted; every notification is a few hundred bytes. */
export const MAX_EVENT_BODY_BYTES = 16 * 1024;

/** How far a request's timestamp may be from this server's clock. */
const TOLERANCE_SECONDS = 5 * 60;

const id = z.string().min(1).max(200);
const timestamp = z.string().min(1).max(64);
// Statuses go into the line that wakes the agent, so only plain words pass:
// "In Review", "Kyc Expired", "IN_REVIEW", "AWAITING_USER".
const status = z.string().regex(/^[A-Za-z][A-Za-z _-]{0,63}$/);
const count = z.number().int().min(0).nullable();

export const sessionStatusUpdatedBody = z.object({
  event_id: id,
  session_id: id,
  application_id: id,
  status,
  updated_at: timestamp,
});

export const sessionWebhookDeliveryBody = z.object({
  delivery_id: id,
  session_id: id,
  webhook_type: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
  // The destination's host only: a full URL can carry a customer's token.
  destination_host: z.string().regex(/^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/),
  // null when no HTTP response came back (a timeout, a refused connection).
  response_status: z.number().int().min(100).max(599).nullable(),
  attempted_at: timestamp,
});

/** The statuses an import job ends in: READY ends a dry run; the others are terminal. */
export const IMPORT_FINISHED_STATUSES = ["READY", "COMPLETED", "FAILED", "CANCELLED"] as const;

export const sessionImportFinishedBody = z.object({
  import_id: id,
  status: z.enum(IMPORT_FINISHED_STATUSES),
  import_type: z.string().regex(/^[a-z_]{1,64}$/),
  total_rows: count,
  processed_rows: count,
  created_count: count,
  updated_count: count,
  skipped_count: count,
  failed_count: count,
  finished_at: timestamp,
});

export const transactionStatusUpdatedBody = z.object({
  event_id: id,
  transaction_id: id,
  txn_id: id,
  application_id: id,
  status,
  updated_at: timestamp,
});

export type SessionStatusUpdated = z.infer<typeof sessionStatusUpdatedBody>;
export type SessionWebhookDelivery = z.infer<typeof sessionWebhookDeliveryBody>;
export type SessionImportFinished = z.infer<typeof sessionImportFinishedBody>;
export type TransactionStatusUpdated = z.infer<typeof transactionStatusUpdatedBody>;

/**
 * The HMAC key of a Standard Webhooks secret: the base64 after `whsec_`.
 * Throws on a secret that isn't one, so a misconfiguration fails at startup.
 */
export function signingKey(secret: string): Buffer {
  const match = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret.trim());
  const key = match ? Buffer.from(match[1], "base64") : Buffer.alloc(0);
  if (key.length < 24) {
    throw new Error("DIDIT_EVENTS_SECRET must be a Standard Webhooks secret: whsec_ followed by at least 24 bytes of base64.");
  }
  return key;
}

/** The value of a webhook-signature header for this request (for senders and tests). */
export function sign(key: Buffer, id: string, timestamp: number, body: string): string {
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export type SignatureHeaders = { id?: string | null; timestamp?: string | null; signature?: string | null };

/** Whether the request carries a valid, current Standard Webhooks signature. */
export function verify(key: Buffer, headers: SignatureHeaders, body: string, now = Math.floor(Date.now() / 1000)): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(sign(key, id, Number(timestamp), body));
  // The header may list several space-separated signatures (during a secret rotation).
  return signature.split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export type PushResult = { status: number; body?: Record<string, unknown> };

/**
 * Handles one backend notification: verifies it, validates the body, and calls
 * emit. Kept apart from the HTTP framework so it can be tested.
 */
export async function handleBackendEvent<T>(
  key: Buffer,
  headers: SignatureHeaders,
  rawBody: string,
  schema: z.ZodType<T>,
  emit: (body: T) => Promise<unknown>,
): Promise<PushResult> {
  if (!verify(key, headers, rawBody)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      status: 400,
      body: { error: "invalid_body", fields: [...new Set(result.error.issues.map((i) => i.path.join(".")))] },
    };
  }
  try {
    await emit(result.data);
  } catch (err) {
    // Wakeshift unreachable or refused: ask the sender to retry. Retries are
    // safe because each emit's id comes from the notification's own IDs.
    console.error(`[didit-mcp] backend event: emit failed: ${err instanceof Error ? err.name : typeof err}`);
    return { status: 502, body: { error: "emit_failed" } };
  }
  return { status: 204 };
}
