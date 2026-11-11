import { apiRequest, getHeaders, requestContext, resolveApplicationId, resolveOrganizationId } from "../config";
import { ORG_APP_PROPS } from "../orgapp";
import { assertBoolean, DiditError, pathSegment } from "../security";

// The Investigator (Didit's AI case reviewer) over its /v3 client API: /v3/investigator/...
// Like travel rule there is no org/app segment in the path: the backend authorizes the acting
// user's Bearer through X-Didit-Organization-Id / X-Didit-Application-Id. What a caller may read
// and decide follows the item kinds of its role (read:/write: sessions, cases, transactions; an
// API key needs its `decisions` scope); the configuration endpoints (backtests) need
// write:applications. The backend is the enforcer.
//
// Every decision (accept, override, batch accept) and every policy answer is a HUMAN decision
// the Investigator only recommends: those tools are annotated destructive and refuse to run
// without confirm:true, which a client may only send after the user approved that exact action.
//
// Every call says where the user acted from (X-Didit-Actor-Via: "copilot" when the console
// assistant marked its MCP request so, otherwise "mcp"), so the Investigator Activity shows it.

type ToolDef = { name: string; description: string; inputSchema: any };

const QUEUES = ["kyc", "kyb", "aml", "transactions", "cases"];
const KINDS = ["session", "business_session", "transaction", "case"];
const RECOMMENDATIONS = ["approve", "decline", "escalate", "request"];
const OVERRIDE_CATEGORIES = ["missing_context", "needs_information", "policy_differs", "evidence_misread", "other"];
const POLICY_ANSWERS = ["approve", "decline", "request", "person"];
const QUESTION_STATUSES = ["open", "answered", "dismissed"];
const ACTIVITY_GROUPS = ["agent", "decisions", "overrides", "autonomy"];
const SCOPES = ["all", "identity", "transactions"];
const BATCH_ACCEPT_LIMIT = 50;
const NOTE_MAX_LENGTH = 2000;

/** Why a tool needs confirm:true, in its schema and in the refusal. */
const DECISION_REASON = "is a human decision the Investigator only recommends";
const REREVIEW_REASON = "replaces its open report";

const confirmProp = (why: string) =>
  ({
    type: "boolean",
    description: `REQUIRED. Must be true - this ${why}. Only set after explicit user confirmation of this exact action.`,
  }) as const;

const CONFIRM_PROP = confirmProp(DECISION_REASON);

const SCOPE_PROP = {
  type: "string",
  enum: SCOPES,
  description: "all (default), identity (sessions and the cases no transaction rule opened) or transactions.",
} as const;

const PAGE_PROPS = {
  limit: { type: "number", description: "Page size." },
  offset: { type: "number", description: "Rows to skip." },
} as const;

const APPROVAL_NOTE =
  " Requires human approval: describe the exact action to the user, wait for their explicit confirmation, then call with confirm:true.";

export const INVESTIGATOR_TOOL_DEFS: ToolDef[] = [
  {
    name: "didit_investigator_queue_list",
    description:
      "List the Investigator's open reports (the review queue), Ready to accept first. Each row has run_id, the item, " +
      "the recommendation (approve/decline/escalate/request), confidence and ready_to_accept. Read the full report with " +
      "didit_investigator_report_get.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        scope: SCOPE_PROP,
        kind: { type: "string", description: `Item kind, or several separated by commas: ${KINDS.join(", ")}.` },
        queue: { type: "string", enum: QUEUES },
        recommendation: { type: "string", enum: RECOMMENDATIONS },
        confidence: { type: "string", enum: ["high", "moderate", "low"] },
        ready: { type: "boolean", description: "true: only Ready to accept; false: only the others." },
        search: { type: "string", description: "Name, company, case number or transaction id." },
        ...PAGE_PROPS,
      },
    },
  },
  {
    name: "didit_investigator_report_get",
    description:
      "Get one Investigator report: recommendation, confidence, risk, narrative, the basis (policy rules), evidence with " +
      "its sources, guardrails, precedents (similar past decisions), questions and provenance (model, prompt hash, " +
      "policy version). Use it to explain why the Investigator recommended something.",
    inputSchema: {
      type: "object" as const,
      properties: { ...ORG_APP_PROPS, run_id: { type: "string", description: "The report's run_id (from the queue)." } },
      required: ["run_id"],
    },
  },
  {
    name: "didit_investigator_accept",
    description:
      "Accept the Investigator's recommendation on one item: the item is decided through its normal route (approve, " +
      "decline, request information or escalate) and logged in the Investigator Activity under the user's name. A " +
      "changed narrative makes it 'edited and accepted'." +
      APPROVAL_NOTE,
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        run_id: { type: "string" },
        narrative: { type: "string", description: "Optional edited narrative (max 4000 characters)." },
        confirm: CONFIRM_PROP,
      },
      required: ["run_id", "confirm"],
    },
  },
  {
    name: "didit_investigator_override",
    description:
      "Override the Investigator: decide one item with another action, a category and a reason (10-500 characters). " +
      "Also overrides a decision the Investigator automated while it still stands; repeated overrides become policy " +
      "questions." +
      APPROVAL_NOTE,
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        run_id: { type: "string" },
        action: { type: "string", enum: RECOMMENDATIONS, description: "The decision to take instead." },
        category: { type: "string", enum: OVERRIDE_CATEGORIES },
        reason: { type: "string", description: "Why, in 10 to 500 characters." },
        confirm: CONFIRM_PROP,
      },
      required: ["run_id", "action", "category", "reason", "confirm"],
    },
  },
  {
    name: "didit_investigator_batch_accept",
    description:
      `Accept up to ${BATCH_ACCEPT_LIMIT} ready recommendations at once; each item is its own decision and one that ` +
      "cannot be accepted is skipped with its reason. List the items and their recommendations to the user first." +
      APPROVAL_NOTE,
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        run_ids: { type: "array", items: { type: "string" }, description: `1 to ${BATCH_ACCEPT_LIMIT} run ids.` },
        confirm: CONFIRM_PROP,
      },
      required: ["run_ids", "confirm"],
    },
  },
  {
    name: "didit_investigator_add_note",
    description:
      "Record a fact the user adds about a report's item as a team note (any kind: verification, business, " +
      "transaction, case). The note shows with the report and the Investigator reads it on its NEXT review of the " +
      "item; it does not re-evaluate on its own. To have it review the item again now, use " +
      "didit_investigator_rereview (it can carry the note itself).",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        run_id: { type: "string", description: "The report's run_id." },
        note: { type: "string", description: `The fact, in the user's own words (max ${NOTE_MAX_LENGTH} characters).` },
      },
      required: ["run_id", "note"],
    },
  },
  {
    name: "didit_investigator_rereview",
    description:
      "Ask the Investigator to review an item again (for example after the user added a fact): a fresh review " +
      "starts in the background and replaces the item's open report when it starts. The usual stage, spending limit " +
      "and guardrails apply and the Investigator never decides that review on its own. Only the item's open, " +
      "finished report can be re-reviewed (409 not_rereviewable), and one at a time (409 rereview_pending). Read the " +
      "new report with didit_investigator_queue_list / didit_investigator_report_get once it is ready." +
      APPROVAL_NOTE,
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        run_id: { type: "string", description: "The open report's run_id." },
        note: {
          type: "string",
          description: `Optional fact to record as a team note and give the new review (max ${NOTE_MAX_LENGTH} characters).`,
        },
        confirm: confirmProp(REREVIEW_REASON),
      },
      required: ["run_id", "confirm"],
    },
  },
  {
    name: "didit_investigator_record_get",
    description:
      "Get the Investigator's review of one verification (session_id, KYC or KYB) or one transaction " +
      "(transaction_id): its newest run, open or decided, with run_id, status, recommendation, confidence, " +
      "summary, whether it was automated and who decided it; null when it never had one. Use it for a record " +
      "the queue does not list (decided items, a record page). Read the full report with " +
      "didit_investigator_report_get once status is completed. A case's run is in didit_case_get's investigator.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        session_id: { type: "string", description: "The verification's session id." },
        transaction_id: { type: "string", description: "The transaction's id." },
      },
    },
  },
  {
    name: "didit_investigator_question_list",
    description:
      "List the Investigator's policy questions (situations its policy does not cover, or rules the team keeps " +
      "overriding), newest first, with counts. One page of 50 unless `limit` says otherwise: `count` is the total " +
      "and `offset` reads the ones after.",
    inputSchema: {
      type: "object" as const,
      properties: { ...ORG_APP_PROPS, status: { type: "string", enum: QUESTION_STATUSES }, ...PAGE_PROPS },
    },
  },
  {
    name: "didit_investigator_question_get",
    description: "Get one policy question with the team's last 30 days on that situation and the four possible answers.",
    inputSchema: {
      type: "object" as const,
      properties: { ...ORG_APP_PROPS, question_id: { type: "string" } },
      required: ["question_id"],
    },
  },
  {
    name: "didit_investigator_question_answer",
    description:
      "Answer a policy question: approve, decline, request (ask for more information) or person (always ask a person). " +
      "Any answer but 'no change' writes a new policy version and re-checks the waiting reports of that queue." +
      APPROVAL_NOTE,
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        question_id: { type: "string" },
        answer: { type: "string", enum: POLICY_ANSWERS },
        detail: { type: "string", description: "Optional condition or note for the rule." },
        confirm: CONFIRM_PROP,
      },
      required: ["question_id", "answer", "confirm"],
    },
  },
  {
    name: "didit_investigator_question_dismiss",
    description: "Close a policy question without an answer; the policy stays as it is." + APPROVAL_NOTE,
    inputSchema: {
      type: "object" as const,
      properties: { ...ORG_APP_PROPS, question_id: { type: "string" }, confirm: CONFIRM_PROP },
      required: ["question_id", "confirm"],
    },
  },
  {
    name: "didit_investigator_backtest_start",
    description:
      "Start a FREE deterministic backtest: replay the current policy (or the setup or SOP draft) on the last 30 or 90 " +
      "days of decisions and get agreement per queue and tier, with sample warnings. Decides nothing. Read it again " +
      "with didit_investigator_backtest_get.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        queues: { type: "array", items: { type: "string", enum: QUEUES }, description: "Queues to replay." },
        period_days: { type: "number", enum: [30, 90], description: "Days to replay (30 by default)." },
        source: { type: "string", enum: ["policy", "setup", "sop_draft"], description: "What to replay (policy by default)." },
      },
      required: ["queues"],
    },
  },
  {
    name: "didit_investigator_backtest_get",
    description: "Get a stored free backtest: agreement for every queue, tier and threshold, and its sample warnings.",
    inputSchema: {
      type: "object" as const,
      properties: { ...ORG_APP_PROPS, backtest_id: { type: "string" } },
      required: ["backtest_id"],
    },
  },
  {
    name: "didit_investigator_performance_get",
    description:
      "Get the Investigator's performance: agreement with the team, volume, time saved, calibration, per-queue numbers " +
      "and overrides over 7, 30 or 90 days.",
    inputSchema: {
      type: "object" as const,
      properties: { ...ORG_APP_PROPS, scope: SCOPE_PROP, period: { type: "number", enum: [7, 30, 90] } },
    },
  },
  {
    name: "didit_investigator_dashboard_get",
    description: "Get the Investigator dashboard: 30-day automation, weekly history, spend, overrides and QA since go-live.",
    inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, scope: SCOPE_PROP } },
  },
  {
    name: "didit_investigator_activity_list",
    description:
      "List the Investigator's append-only Activity log, newest first: what the agent and people did (reports, " +
      "decisions, overrides, autonomy and guardrail changes), each with its actor and provenance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...ORG_APP_PROPS,
        scope: SCOPE_PROP,
        group: { type: "string", enum: ACTIVITY_GROUPS },
        actor: { type: "string", description: "'agent', or a person's email." },
        since: { type: "string", description: "ISO date-time, inclusive." },
        until: { type: "string", description: "ISO date-time, exclusive." },
        ...PAGE_PROPS,
      },
    },
  },
];

const INVESTIGATOR_TOOL_NAMES = new Set(INVESTIGATOR_TOOL_DEFS.map((tool) => tool.name));

export function isInvestigatorToolName(name: string): boolean {
  return INVESTIGATOR_TOOL_NAMES.has(name);
}

/** The decisions, the policy answers and the re-review (it replaces the open report): annotated destructive,
 *  gated on confirm:true. */
export const INVESTIGATOR_DECISION_TOOLS: string[] = [
  "didit_investigator_accept",
  "didit_investigator_override",
  "didit_investigator_batch_accept",
  "didit_investigator_question_answer",
  "didit_investigator_question_dismiss",
  "didit_investigator_rereview",
];

/** Read-like by name, but it stores a backtest. */
export const INVESTIGATOR_WRITE_TOOLS: string[] = ["didit_investigator_backtest_start"];

// What the backend checks for a console user. Reads and decisions accept ANY read/write
// permission over the item kinds (sessions, cases, transactions), which a single permission
// string cannot express: no pre-check there, the backend filters by kind.
export const INVESTIGATOR_TOOL_PERMISSIONS: Record<string, string | null> = {
  didit_investigator_queue_list: null, // GET /v3/investigator/queue/ — any read/list over the item kinds
  didit_investigator_report_get: null, // GET runs/{id}/ — read over the item's kind
  didit_investigator_accept: null, // POST runs/{id}/accept/ — write over the item's kind
  didit_investigator_override: null, // POST runs/{id}/override/ — write over the item's kind
  didit_investigator_batch_accept: null, // POST runs/batch-accept/ — write, per item
  didit_investigator_add_note: null, // POST runs/{id}/notes/ — write over the item's kind
  didit_investigator_rereview: null, // POST runs/{id}/rereview/ — write over the item's kind
  didit_investigator_record_get: null, // GET sessions/{id}/ or transactions/{id}/ — read:sessions or read:transactions
  didit_investigator_question_list: null, // GET questions/ — any read
  didit_investigator_question_get: null, // GET questions/{id}/ — any read
  didit_investigator_question_answer: null, // POST questions/{id}/answer/ — write over the question's item
  didit_investigator_question_dismiss: null, // POST questions/{id}/dismiss/ — write over the question's item
  didit_investigator_backtest_start: "write:applications", // POST backtests/ — InvestigatorConfigView write
  didit_investigator_backtest_get: null, // GET backtests/{id}/ — any read (config read)
  didit_investigator_performance_get: null, // GET performance/ — any read
  didit_investigator_dashboard_get: null, // GET dashboard/ — any read
  didit_investigator_activity_list: null, // GET activity/ — any read
};

/** The allowlisted X-Didit-Actor-Via of an incoming MCP request: "copilot" from the console
 *  assistant, anything else (absent, unknown) is "mcp". */
export function actorViaFromHeaders(headers: Record<string, string | string[] | undefined> | undefined): "copilot" | "mcp" {
  const raw = headers?.["x-didit-actor-via"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return value === "copilot" ? "copilot" : "mcp";
}

function clientHeaders(): Record<string, string> {
  return {
    ...getHeaders(),
    "X-Didit-Organization-Id": resolveOrganizationId(),
    "X-Didit-Application-Id": resolveApplicationId(),
    "X-Didit-Actor-Via": requestContext.getStore()?.actorVia ?? "mcp",
  };
}

function call(path: string, opts: { method?: string; json?: any; params?: Record<string, any> } = {}): Promise<any> {
  return apiRequest(path, { ...opts, headers: clientHeaders() });
}

function assertConfirmed(confirm: unknown, what: string, why = DECISION_REASON): void {
  assertBoolean(confirm, "confirm");
  if (confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: `${what} ${why}.`,
      field: "confirm",
      hint: "Show the user the exact action, and re-call with confirm:true only once they have explicitly approved it.",
    });
  }
}

function pick(args: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== "") out[key] = args[key];
  }
  return out;
}

const runPath = (id: unknown) => `/investigator/runs/${pathSegment(id, "run_id")}/`;
const questionPath = (id: unknown) => `/investigator/questions/${pathSegment(id, "question_id")}/`;

/** The record path for exactly one of session_id or transaction_id. */
function recordPath(args: Record<string, any>): string {
  const ids = pick(args, ["session_id", "transaction_id"]);
  if (Object.keys(ids).length !== 1) {
    throw new DiditError({
      code: "bad_request",
      message: "Pass exactly one of session_id or transaction_id.",
      field: "session_id",
    });
  }
  return ids.session_id
    ? `/investigator/sessions/${pathSegment(ids.session_id, "session_id")}/`
    : `/investigator/transactions/${pathSegment(ids.transaction_id, "transaction_id")}/`;
}

/** The note text: trimmed, required unless optional, at most NOTE_MAX_LENGTH characters. */
function noteText(value: unknown, required: boolean): string {
  const note = typeof value === "string" ? value.trim() : "";
  if (required && !note) {
    throw new DiditError({ code: "bad_request", message: "note is required.", field: "note" });
  }
  if (note.length > NOTE_MAX_LENGTH) {
    throw new DiditError({ code: "bad_request", message: `note must be at most ${NOTE_MAX_LENGTH} characters.`, field: "note" });
  }
  return note;
}

export async function dispatchInvestigatorTool(name: string, rawArgs: Record<string, any> | undefined): Promise<any> {
  const args = rawArgs ?? {};
  switch (name) {
    case "didit_investigator_queue_list": {
      const params = pick(args, ["scope", "kind", "queue", "recommendation", "confidence", "search", "limit", "offset"]);
      if (typeof args.ready === "boolean") params.ready = String(args.ready);
      return call("/investigator/queue/", { params });
    }
    case "didit_investigator_report_get":
      return call(runPath(args.run_id));
    case "didit_investigator_accept":
      assertConfirmed(args.confirm, "Accepting a recommendation");
      return call(`${runPath(args.run_id)}accept/`, { method: "POST", json: pick(args, ["narrative"]) });
    case "didit_investigator_override":
      assertConfirmed(args.confirm, "Overriding a recommendation");
      return call(`${runPath(args.run_id)}override/`, {
        method: "POST",
        json: pick(args, ["action", "category", "reason"]),
      });
    case "didit_investigator_batch_accept": {
      assertConfirmed(args.confirm, "Accepting a batch of recommendations");
      const runIds = args.run_ids;
      if (!Array.isArray(runIds) || runIds.length === 0 || runIds.length > BATCH_ACCEPT_LIMIT) {
        throw new DiditError({
          code: "bad_request",
          message: `run_ids must list 1 to ${BATCH_ACCEPT_LIMIT} run ids.`,
          field: "run_ids",
        });
      }
      return call("/investigator/runs/batch-accept/", {
        method: "POST",
        json: { run_ids: runIds.map((id) => pathSegment(id, "run_ids")) },
      });
    }
    case "didit_investigator_add_note":
      return call(`${runPath(args.run_id)}notes/`, { method: "POST", json: { text: noteText(args.note, true) } });
    case "didit_investigator_rereview": {
      assertConfirmed(args.confirm, "Re-reviewing an item", REREVIEW_REASON);
      const note = noteText(args.note, false);
      return call(`${runPath(args.run_id)}rereview/`, { method: "POST", json: note ? { note } : {} });
    }
    case "didit_investigator_record_get":
      return call(recordPath(args));
    case "didit_investigator_question_list":
      return call("/investigator/questions/", { params: pick(args, ["status", "limit", "offset"]) });
    case "didit_investigator_question_get":
      return call(questionPath(args.question_id));
    case "didit_investigator_question_answer":
      assertConfirmed(args.confirm, "Answering a policy question");
      return call(`${questionPath(args.question_id)}answer/`, {
        method: "POST",
        json: pick(args, ["answer", "detail"]),
      });
    case "didit_investigator_question_dismiss":
      assertConfirmed(args.confirm, "Dismissing a policy question");
      return call(`${questionPath(args.question_id)}dismiss/`, { method: "POST" });
    case "didit_investigator_backtest_start":
      return call("/investigator/backtests/", { method: "POST", json: pick(args, ["queues", "period_days", "source"]) });
    case "didit_investigator_backtest_get":
      return call(`/investigator/backtests/${pathSegment(args.backtest_id, "backtest_id")}/`);
    case "didit_investigator_performance_get":
      return call("/investigator/performance/", { params: pick(args, ["scope", "period"]) });
    case "didit_investigator_dashboard_get":
      return call("/investigator/dashboard/", { params: pick(args, ["scope"]) });
    case "didit_investigator_activity_list":
      return call("/investigator/activity/", { params: pick(args, ["scope", "group", "actor", "since", "until", "limit", "offset"]) });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
