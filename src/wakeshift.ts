/**
 * Wakeshift events: wake the agent that asked when something happens in Didit,
 * instead of having it poll.
 *
 * session.status.updated          a verification session's status changed (In Review, Approved, Declined…).
 *                                 Subscribed by didit_session_create and didit_session_watch.
 * session.in_review               a session of an application went to In Review (the manual-review queue).
 *                                 Subscribed by didit_session_watch_reviews.
 * session.webhook_delivery.logged Didit logged a webhook delivery attempt for a session.
 *                                 Subscribed by didit_session_webhooks.
 * session_import.finished         an import job finished: a dry run ended READY, or the import COMPLETED,
 *                                 FAILED or was CANCELLED. Subscribed by didit_session_create_import and
 *                                 didit_session_manage_import (start, resume, retry).
 * transaction.status.updated      a monitored transaction's status changed. Subscribed by didit_transaction_create.
 * transaction.in_review           a transaction of an application went to IN_REVIEW.
 *                                 Subscribed by didit_transaction_watch_reviews.
 *
 * The Didit backend reports each change to POST /internal/events/<event>
 * (backend-events.ts, docs/backend-events.md), and those routes emit. Nothing polls.
 * Payloads carry IDs, statuses, counts and times only: never personal data,
 * decisions, documents or webhook payloads. The agent reads the details with the
 * existing tools, under its own credential.
 *
 * This module is loaded only when Wakeshift is on (HTTP, with both WAKESHIFT_KEY
 * and DIDIT_EVENTS_SECRET set; see http.ts). Otherwise nothing here runs and
 * every tool behaves as it did before.
 */

import { createHash } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Wakeshift, encodeArgValue, isWakeshiftError, type AnyEvent } from "@wakeshift/sdk";
import { z } from "zod";
import * as sessions from "./tools/sessions";
import * as transactions from "./tools/transactions";
import { resolveApplicationId } from "./config";
import { ORG_APP_PROPS } from "./orgapp";
import { apiKeyScopeOf } from "./api-key-connection";
import { TOOL_CALL_READ, TOOL_CALL_WRITE } from "./tools/discovery";
import {
  sessionImportFinishedBody,
  sessionStatusUpdatedBody,
  sessionWebhookDeliveryBody,
  transactionStatusUpdatedBody,
  type SessionImportFinished,
  type SessionStatusUpdated,
  type SessionWebhookDelivery,
  type TransactionStatusUpdated,
} from "./backend-events";

/** A watch on a session or transaction ends after this long with no change and no renewal. */
export const STATUS_WATCH_TTL = "7d";
/** A watch on a session's webhook deliveries ends after this long with no delivery. */
export const DELIVERY_WATCH_TTL = "1h";
/** A watch on an application's review queue ends after this long with nothing new in review. */
export const REVIEW_WATCH_TTL = "7d";
/**
 * How far back a subscribe also delivers the latest occurrence, so one emitted
 * between the tool's API call and its subscribe isn't missed. Every event this
 * applies to is keyed by an ID the call just created or read.
 */
const CATCH_UP = "10m";
/** An import can finish within seconds of being created, or between create and subscribe. */
const IMPORT_CATCH_UP = "1h";
/**
 * The watch tools read first (the access check), then subscribe: a change reported in between
 * is delivered too. Short, so a change from before the read (which the read already showed)
 * rarely wakes the agent again.
 */
const READ_CATCH_UP = "2m";

/**
 * Session statuses that wake an agent. "Not Started" is where every session
 * begins, and "In Progress" only means the person opened the link: waking an
 * agent for either would be noise.
 */
const QUIET_SESSION_STATUSES = new Set(["Not Started", "In Progress"]);

/**
 * The tools this module adds to the hosted full profile. Their names put them in the toolsets of
 * the tools they extend (toolsets.ts matches by prefix): `sessions` and `transactions`.
 */
export const WAKESHIFT_TOOL_NAMES = ["didit_session_watch", "didit_session_watch_reviews", "didit_transaction_watch_reviews"];

/**
 * The Didit tool whose role permission each watch tool needs (permissions.ts): the read it
 * makes as its access check. A role that may not list transactions is not offered the watch on
 * them, exactly as it is not offered the list.
 */
const PERMISSION_AS: Readonly<Record<string, string>> = {
  didit_session_watch: "didit_session_get_decision",
  didit_session_watch_reviews: "didit_session_list",
  didit_transaction_watch_reviews: "didit_transaction_list",
};

/** Existing tools that subscribe and only read Didit (annotated read-only in index.ts). */
const READ_TOOLS_THAT_SUBSCRIBE = new Set(["didit_session_webhooks"]);

/** What createServer (index.ts) needs from Wakeshift. */
export interface WakeshiftHooks {
  /** Tool definitions appended to the hosted full profile (every toolset selection of it). */
  toolDefinitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> & { type: "object" } }>;
  /** An existing tool's description, as listed with Wakeshift on. */
  describe(name: string, description: string): string;
  /** Whether this module answers the tool itself (the watch tools). */
  handles(name: string): boolean;
  /**
   * Whether a tool of this module is read-only in Didit's sense (annotationsFor in index.ts):
   * the watch tools read Didit to check access and change no Didit data, so they are listed and
   * run on a read-only connection and through didit_tool_call_read.
   */
  readOnly(name: string): boolean;
  /** The Didit tool whose role permission this tool needs (permissions.ts), if it is one of ours. */
  permissionAs(name: string): string | undefined;
  /** Runs a watch tool. Called inside the request's credential context. */
  call(name: string, args: Record<string, any>): Promise<unknown>;
  /** After an existing tool succeeded: subscribe the conversation to what it started. */
  after(name: string, args: Record<string, any>, result: any): Promise<void>;
  /** Attaches Wakeshift to one MCP server, after its handlers are set. */
  attach(server: Server): void;
}

/**
 * A Wakeshift user ID for the caller, never a credential.
 *
 * A person's sign-in: an opaque hash of the token's subject (the person).
 * An application API key (api-key-connection.ts): no person is behind it, so an opaque hash of
 * the application and the key's id (the primary key has none). Each key is its own subscriber:
 * a restricted key never lists or ends what a full-access key of the same application
 * subscribed. The key itself never goes into the hash. The prefixes keep the two apart.
 */
export function userIdFor(authInfo: { extra?: Record<string, unknown> } | undefined): string | undefined {
  const key = apiKeyScopeOf(authInfo as Parameters<typeof apiKeyScopeOf>[0]);
  if (key) {
    if (!key.applicationId) return undefined;
    const hash = createHash("sha256").update(`didit-api-key\n${key.applicationId}\n${key.keyId ?? "primary"}`).digest("hex");
    return "didit-key-" + hash.slice(0, 32);
  }
  const sub = authInfo?.extra?.sub;
  if (typeof sub !== "string" && typeof sub !== "number") return undefined;
  return "didit-" + createHash("sha256").update(`didit-user\n${sub}`).digest("hex").slice(0, 32);
}

/**
 * An emit id: a hash of the event and the notification's own IDs, so it has a
 * fixed length (Wakeshift takes at most 200 characters) and a retried
 * notification emits once.
 */
export function emitId(event: string, ...ids: string[]): string {
  return createHash("sha256").update([event, ...ids].join("\n")).digest("hex");
}

/**
 * Runs one emit. An id Wakeshift already took with a different payload (a retry
 * whose body changed, say a recomputed timestamp) means this change was already
 * emitted: it counts as done, not as a failure the backend should retry forever.
 */
async function once(emit: () => Promise<unknown>): Promise<void> {
  try {
    await emit();
  } catch (err) {
    if (isWakeshiftError(err, "id_reused")) return;
    throw err;
  }
}

/** Defines Didit's events on a Wakeshift client, and everything that subscribes and emits them. */
export function createDiditWakeshift(wake: Wakeshift) {
  // Every argument is an ID: encodeArgValue keeps case-sensitive IDs apart.
  const arg = (value: string) => encodeArgValue(value);

  const sessionStatus = wake.defineEvent("session.status.updated", {
    description: "A Didit verification session's status changed",
    args: z.object({ session: z.string() }),
    payload: z.object({
      session_id: z.string(),
      application_id: z.string(),
      status: z.string(),
      updated_at: z.string(),
    }),
    text: (p) => `Didit verification session ${p.session_id} is now ${p.status}. Read it with didit_session_get_decision.`,
  });

  const sessionInReview = wake.defineEvent("session.in_review", {
    description: "A Didit verification session went to In Review (manual review)",
    args: z.object({ application: z.string() }),
    payload: z.object({
      session_id: z.string(),
      application_id: z.string(),
      updated_at: z.string(),
    }),
    text: (p) => `Didit verification session ${p.session_id} is In Review. Read it with didit_session_get_decision.`,
  });

  const deliveryLogged = wake.defineEvent("session.webhook_delivery.logged", {
    description: "Didit logged a webhook delivery attempt for a verification session",
    args: z.object({ session: z.string() }),
    payload: z.object({
      session_id: z.string(),
      delivery_id: z.string(),
      webhook_type: z.string(),
      destination_host: z.string(),
      response_status: z.number().nullable(),
      attempted_at: z.string(),
    }),
    text: (p) =>
      `Didit sent ${p.webhook_type} for session ${p.session_id} to ${p.destination_host}: ` +
      `${p.response_status === null ? "no response" : `HTTP ${p.response_status}`}. Details with didit_session_webhooks.`,
  });

  const importFinished = wake.defineEvent("session_import.finished", {
    description: "A Didit import job finished",
    // run: "dry_run" for a dry run ending READY, "import" for an import ending
    // COMPLETED, FAILED or CANCELLED, so a watch on the real import is never
    // ended by the dry run's earlier occurrence.
    args: z.object({ import: z.string(), run: z.enum(["dry_run", "import"]) }),
    payload: z.object({
      import_id: z.string(),
      status: z.string(),
      import_type: z.string(),
      total_rows: z.number().nullable(),
      processed_rows: z.number().nullable(),
      created_count: z.number().nullable(),
      updated_count: z.number().nullable(),
      skipped_count: z.number().nullable(),
      failed_count: z.number().nullable(),
      finished_at: z.string(),
    }),
    text: (p) =>
      p.status === "READY"
        ? `Didit import ${p.import_id} finished its dry run (READY). Read it with didit_session_get_import; start it with didit_session_manage_import.`
        : `Didit import ${p.import_id} is ${p.status}. Read it with didit_session_get_import${p.failed_count ? " and didit_session_get_import_errors" : ""}.`,
  });

  const transactionStatus = wake.defineEvent("transaction.status.updated", {
    description: "A monitored Didit transaction's status changed",
    args: z.object({ application: z.string(), transaction: z.string() }),
    payload: z.object({
      transaction_id: z.string(),
      txn_id: z.string(),
      application_id: z.string(),
      status: z.string(),
      updated_at: z.string(),
    }),
    text: (p) => `Didit transaction ${p.txn_id} is now ${p.status}. Read it with didit_transaction_get.`,
  });

  const transactionInReview = wake.defineEvent("transaction.in_review", {
    description: "A monitored Didit transaction went to IN_REVIEW",
    args: z.object({ application: z.string() }),
    payload: z.object({
      transaction_id: z.string(),
      txn_id: z.string(),
      application_id: z.string(),
      updated_at: z.string(),
    }),
    text: (p) => `Didit transaction ${p.txn_id} is IN_REVIEW. Read it with didit_transaction_get.`,
  });

  // ── Emits, one per backend notification ─────────────────────────────

  async function emitSessionStatus(b: SessionStatusUpdated) {
    if (QUIET_SESSION_STATUSES.has(b.status)) return;
    const payload = { session_id: b.session_id, application_id: b.application_id, status: b.status, updated_at: b.updated_at };
    await once(() => sessionStatus.emit({ session: arg(b.session_id) }, payload, { id: emitId(sessionStatus.name, b.event_id) }));
    if (b.status === "In Review") {
      await once(() =>
        sessionInReview.emit(
          { application: arg(b.application_id) },
          { session_id: b.session_id, application_id: b.application_id, updated_at: b.updated_at },
          { id: emitId(sessionInReview.name, b.event_id) },
        ),
      );
    }
  }

  async function emitDelivery(b: SessionWebhookDelivery) {
    await once(() => deliveryLogged.emit({ session: arg(b.session_id) }, b, { id: emitId(deliveryLogged.name, b.session_id, b.delivery_id) }));
  }

  async function emitImportFinished(b: SessionImportFinished) {
    const run = b.status === "READY" ? "dry_run" : "import";
    await once(() => importFinished.emit({ import: arg(b.import_id), run }, b, { id: emitId(importFinished.name, b.import_id, b.status) }));
  }

  async function emitTransactionStatus(b: TransactionStatusUpdated) {
    const payload = { transaction_id: b.transaction_id, txn_id: b.txn_id, application_id: b.application_id, status: b.status, updated_at: b.updated_at };
    await once(() =>
      transactionStatus.emit(
        { application: arg(b.application_id), transaction: arg(b.txn_id) },
        payload,
        { id: emitId(transactionStatus.name, b.event_id) },
      ),
    );
    if (b.status === "IN_REVIEW") {
      await once(() =>
        transactionInReview.emit(
          { application: arg(b.application_id) },
          { transaction_id: b.transaction_id, txn_id: b.txn_id, application_id: b.application_id, updated_at: b.updated_at },
          { id: emitId(transactionInReview.name, b.event_id) },
        ),
      );
    }
  }

  /** The backend's routes: path, body schema, emit. Mounted by http.ts. */
  const routes = [
    { path: "/internal/events/session-status-updated", schema: sessionStatusUpdatedBody, emit: emitSessionStatus },
    { path: "/internal/events/session-webhook-delivery", schema: sessionWebhookDeliveryBody, emit: emitDelivery },
    { path: "/internal/events/session-import-finished", schema: sessionImportFinishedBody, emit: emitImportFinished },
    { path: "/internal/events/transaction-status-updated", schema: transactionStatusUpdatedBody, emit: emitTransactionStatus },
  ] as const;

  // ── Subscribes ──────────────────────────────────────────────────────

  const watchSession = (sessionId: string, replay: string) =>
    wake.currentCall().subscribe(sessionStatus, { session: arg(sessionId) }, {
      ttl: STATUS_WATCH_TTL,
      replay,
      reason: `Watching Didit session ${sessionId}`,
    });

  /** Tools that subscribe, each with its events. */
  const subscribing: Readonly<Record<string, readonly AnyEvent[]>> = {
    didit_session_create: [sessionStatus],
    didit_session_watch: [sessionStatus],
    didit_session_watch_reviews: [sessionInReview],
    didit_session_webhooks: [deliveryLogged],
    didit_session_create_import: [importFinished],
    didit_session_manage_import: [importFinished],
    didit_transaction_create: [transactionStatus],
    didit_transaction_watch_reviews: [transactionInReview],
  };
  const isRead = (name: string) => WAKESHIFT_TOOL_NAMES.includes(name) || READ_TOOLS_THAT_SUBSCRIBE.has(name);
  const eventsOf = (names: string[]) => [...new Set(names.flatMap((name) => subscribing[name]))];
  /**
   * A connection that lists only some toolsets reaches the rest through didit_tool_call_read and
   * didit_tool_call_write (tools/discovery.ts). The tool they run is unwrapped inside Didit's
   * handler, so Wakeshift sees the proxy: each proxy subscribes to what the tools it may run do
   * (the read one runs only read-only tools). Its call then carries Wakeshift's arguments, and
   * the subscribe of the tool it runs works.
   */
  const viaProxy: Readonly<Record<string, readonly AnyEvent[]>> = {
    [TOOL_CALL_READ]: eventsOf(Object.keys(subscribing).filter(isRead)),
    [TOOL_CALL_WRITE]: eventsOf(Object.keys(subscribing)),
  };
  /**
   * attach's `wrap`. A function rather than a table: a connection's toolsets decide which of
   * these tools it lists, and a tool it does not list still runs when called by name.
   */
  const own = (table: Readonly<Record<string, readonly AnyEvent[]>>, tool: string) =>
    Object.prototype.hasOwnProperty.call(table, tool) ? table[tool] : undefined;
  const wrap = (tool: string): readonly AnyEvent[] | undefined => own(subscribing, tool) ?? own(viaProxy, tool);

  /**
   * Subscribes after an existing tool succeeded. The tool already did its work
   * (a created session may be billed), so a Wakeshift failure is logged and
   * never turns the result into an error.
   */
  async function after(name: string, args: Record<string, any>, result: any): Promise<void> {
    try {
      switch (name) {
        case "didit_session_create": {
          // replay: a sandbox session can change status before this subscribe.
          if (typeof result?.session_id === "string") await watchSession(result.session_id, CATCH_UP);
          return;
        }
        case "didit_session_webhooks": {
          // The read just checked the caller can see the session's deliveries.
          await wake.currentCall().subscribe(deliveryLogged, { session: arg(String(args.session_id)) }, {
            ttl: DELIVERY_WATCH_TTL,
            replay: CATCH_UP,
            reason: `Watching webhook deliveries of Didit session ${args.session_id}`,
          });
          return;
        }
        case "didit_session_create_import": {
          if (typeof result?.uuid !== "string") return;
          await wake.currentCall().subscribe(
            importFinished,
            { import: arg(result.uuid), run: args.dry_run === true ? "dry_run" : "import" },
            { once: true, replay: IMPORT_CATCH_UP, reason: `Watching Didit import ${result.uuid}` },
          );
          return;
        }
        case "didit_session_manage_import": {
          // start and resume run the same job; retry answers with a new one.
          if (!["start", "resume", "retry"].includes(args.action)) return;
          const job = typeof result?.uuid === "string" ? result.uuid : String(args.import_id);
          await wake.currentCall().subscribe(
            importFinished,
            { import: arg(job), run: "import" },
            { once: true, replay: IMPORT_CATCH_UP, reason: `Watching Didit import ${job}` },
          );
          return;
        }
        case "didit_transaction_create": {
          // transaction_id here is the customer's own ID (txn_id in Didit's webhooks),
          // unique within the application the transaction was created in.
          const txn = typeof args.transaction_id === "string" ? args.transaction_id : undefined;
          if (!txn) return;
          await wake.currentCall().subscribe(
            transactionStatus,
            { application: arg(resolveApplicationId()), transaction: arg(txn) },
            { ttl: STATUS_WATCH_TTL, replay: CATCH_UP, reason: `Watching Didit transaction ${txn}` },
          );
          return;
        }
      }
    } catch (err) {
      console.error(`[didit-mcp] wakeshift: ${name} could not subscribe: ${err instanceof Error ? err.name : typeof err}`);
    }
  }

  // ── The watch tools ─────────────────────────────────────────────────

  const toolDefinitions: WakeshiftHooks["toolDefinitions"] = [
    {
      name: "didit_session_watch",
      description:
        "Watch an existing verification session, to wait for its decision without polling: you're woken when its status " +
        "changes (In Review, Approved, Declined, " +
        `Expired, Resubmitted, Awaiting User…), until ${STATUS_WATCH_TTL.replace("d", " days")} pass with no change. ` +
        "didit_session_create already watches the sessions it creates. Returns the session's current status; read the " +
        "decision with didit_session_get_decision.",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string", description: "Session UUID" } },
        required: ["session_id"],
      },
    },
    {
      name: "didit_session_watch_reviews",
      description:
        "Watch ONE application's manual-review queue: you're woken whenever one of its verification sessions goes to In " +
        `Review, until ${REVIEW_WATCH_TTL.replace("d", " days")} pass with none. Returns how many sessions are in review now.`,
      inputSchema: { type: "object", properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_transaction_watch_reviews",
      description:
        "Watch ONE application's flagged transactions: you're woken whenever one of its monitored transactions goes to " +
        `IN_REVIEW, until ${REVIEW_WATCH_TTL.replace("d", " days")} pass with none. didit_transaction_create already ` +
        "watches the transactions it submits.",
      inputSchema: { type: "object", properties: { ...ORG_APP_PROPS } },
    },
  ];

  async function call(name: string, args: Record<string, any>): Promise<unknown> {
    switch (name) {
      case "didit_session_watch": {
        const sessionId = String(args.session_id ?? "");
        // The access check: the caller's own credential must read the session.
        // Only its status is returned; the decision stays unread by the agent.
        const decision = await sessions.getSessionDecision(sessionId);
        await watchSession(sessionId, READ_CATCH_UP);
        return { session_id: sessionId, status: typeof decision?.status === "string" ? decision.status : null, watching: true };
      }
      case "didit_session_watch_reviews": {
        // The access check: the caller's own credential must list the application's sessions.
        const page = await sessions.listSessions({ status: "In Review", limit: "1" });
        const application = resolveApplicationId();
        await wake.currentCall().subscribe(sessionInReview, { application: arg(application) }, {
          ttl: REVIEW_WATCH_TTL,
          replay: READ_CATCH_UP,
          reason: `Watching the review queue of Didit application ${application}`,
        });
        return { application_id: application, in_review_now: page?.total_count ?? page?.count ?? null, watching: true };
      }
      case "didit_transaction_watch_reviews": {
        // The access check: the caller's own credential must list the application's transactions.
        await transactions.listTransactions({ limit: "1" });
        const application = resolveApplicationId();
        await wake.currentCall().subscribe(transactionInReview, { application: arg(application) }, {
          ttl: REVIEW_WATCH_TTL,
          replay: READ_CATCH_UP,
          reason: `Watching flagged transactions of Didit application ${application}`,
        });
        return { application_id: application, watching: true };
      }
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  const hooks: WakeshiftHooks = {
    toolDefinitions,
    describe(name, description) {
      if (name !== "didit_session_webhooks") return description;
      return (
        description +
        ` With notifications on, wait_seconds isn't needed: this call also watches the session's deliveries for ${DELIVERY_WATCH_TTL.replace("h", " hour")} ` +
        "and wakes you when the next one is logged."
      );
    },
    handles: (name) => WAKESHIFT_TOOL_NAMES.includes(name),
    readOnly: (name) => WAKESHIFT_TOOL_NAMES.includes(name),
    permissionAs: (name) => (Object.prototype.hasOwnProperty.call(PERMISSION_AS, name) ? PERMISSION_AS[name] : undefined),
    call,
    after,
    attach(server) {
      wake.attach(server as any, {
        wrap,
        identify: (extra: any) => {
          const user = userIdFor(extra?.authInfo);
          return user ? { user } : undefined;
        },
      });
    },
  };

  return {
    wake,
    hooks,
    routes,
    events: { sessionStatus, sessionInReview, deliveryLogged, importFinished, transactionStatus, transactionInReview },
  };
}

export type DiditWakeshift = ReturnType<typeof createDiditWakeshift>;

/** The production client: WAKESHIFT_KEY from the environment. */
export function createWakeshiftFromEnv(): DiditWakeshift {
  return createDiditWakeshift(new Wakeshift());
}
