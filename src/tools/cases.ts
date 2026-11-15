import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { searchCases } from "./search";
import { ORG_APP_PROPS } from "../orgapp";
import { pathSegment, DiditError } from "../security";

// Case management — org/app-scoped console resource. Read/create are dedicated tools;
// the many per-case actions (assign/resolve/reopen/escalate/comment) fold into one
// action-dispatch tool to keep the surface small.

const cid = (id: string) => pathSegment(id, "case_id");

export async function listCases(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/cases/"), { params });
}

export async function getCase(caseId: string): Promise<any> {
  return apiRequest(orgAppPath(`/cases/${cid(caseId)}/`));
}

export async function createCase(data: Record<string, any>): Promise<any> {
  // A case is about someone or about something. The API refuses one that names neither; say so
  // here, with where the two come from, before anything is sent.
  const hasSubject = Boolean(data?.subject && typeof data.subject === "object");
  const hasLinks = Array.isArray(data?.links) && data.links.length > 0;
  if (!hasSubject && !hasLinks) {
    throw new DiditError({
      code: "bad_request",
      message: "A case needs a subject or at least one link: pass `subject` ({type, uuid}) or `links` ([{entity_type, entity_uuid}]).",
      field: "subject",
      hint: "A subject's uuid is the `didit_internal_id` that didit_vendor_user_get and didit_vendor_business_get return; a session or a transaction is linked by its own id.",
    });
  }
  return apiRequest(orgAppPath("/cases/"), { method: "POST", json: data });
}

export async function caseStatistics(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/cases/statistics/"), { params });
}

const KNOWN_CASE_ACTIONS = ["assign", "resolve", "reopen", "escalate", "comment", "update", "sar", "file_sar"];
const SAR_STATUS = "SAR_FILED";

// action ∈ assign | resolve | reopen | escalate | comment | update | sar
export async function manageCase(
  caseId: string,
  action: string,
  data: Record<string, any> = {},
  confirm?: unknown,
): Promise<any> {
  if (typeof action !== "string" || !KNOWN_CASE_ACTIONS.includes(action)) {
    throw new DiditError({
      code: "bad_request",
      message: "Unknown case action.",
      field: "action",
      hint: `action must be one of: ${KNOWN_CASE_ACTIONS.join(", ")}.`,
      allowed: KNOWN_CASE_ACTIONS,
    });
  }
  // Filing a SAR is a high-impact regulatory action — gate the explicit action AND the
  // status-smuggling path (resolving with status:SAR_FILED) behind confirm:true.
  const callerStatus = typeof data.status === "string" ? data.status.trim().toUpperCase() : undefined;
  const filesSar = action === "sar" || action === "file_sar" || callerStatus === SAR_STATUS;
  if (filesSar && confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: "Filing a SAR (Suspicious Activity Report) is a high-impact regulatory action.",
      field: "confirm",
      hint: "Re-call with confirm:true once a human has authorized filing — applies to action 'sar'/'file_sar' AND any resolve with status:'SAR_FILED'.",
    });
  }
  if (action === "update") {
    return apiRequest(orgAppPath(`/cases/${cid(caseId)}/`), { method: "PATCH", json: data });
  }
  if (action === "comment") {
    return apiRequest(orgAppPath(`/cases/${cid(caseId)}/comments/`), { method: "POST", json: data });
  }
  if (action === "sar" || action === "file_sar") {
    const { status: _s, ...rest } = data;
    return apiRequest(orgAppPath(`/cases/${cid(caseId)}/resolve/`), { method: "POST", json: { ...rest, status: SAR_STATUS } });
  }
  return apiRequest(orgAppPath(`/cases/${cid(caseId)}/${pathSegment(action, "action")}/`), { method: "POST", json: data });
}

// ── The case tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const CASE_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_case_list",
      description: "List investigation/compliance cases for ONE app; with multiple apps (or no scope) it auto-spans all your apps. For a cross-app query prefer didit_case_search.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, status: { type: "string" }, cursor: { type: "string" } } },
    },
    access: "read",
    permission: "list:cases", // GET …/cases/ → case_management.py:264
    run: (args) => listCases(args),
    spanAllApplications: (args) => searchCases(args),
  },
  {
    def: {
      name: "didit_case_get",
      description: "Get a case with its details.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, case_id: { type: "string" } }, required: ["case_id"] },
    },
    access: "read",
    permission: "read:cases", // GET …/cases/{id}/ → case_management.py:353
    run: (args) => getCase(args.case_id),
  },
  {
    def: {
      name: "didit_case_create",
      description:
        "Open a case for a compliance review. A case is about a subject (one of your users or businesses) or is " +
        "linked to at least one session or transaction: pass `subject`, `links` or both. `subject.uuid` is the " +
        "`didit_internal_id` of the user or the business, as didit_vendor_user_get and didit_vendor_business_get " +
        "return it; it is not their vendor_data. Returns the case with its `uuid`. With review_duplicates true the API first looks " +
        "for cases already open about the same subject and answers 409 case_duplicate_review_required when it finds " +
        "one: show it to the person, and to open a separate case anyway send separate_incident_reason.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          title: { type: "string", description: "What the case is about, in one line (255 characters at most)." },
          subject: {
            type: "object",
            description: "Who the case is about. Required unless `links` is given.",
            properties: {
              type: { type: "string", enum: ["user", "business"] },
              uuid: { type: "string", description: "The `didit_internal_id` of that user or business." },
            },
            required: ["type", "uuid"],
          },
          links: {
            type: "array",
            description: "What the case is linked to, 20 at most. Required unless `subject` is given.",
            items: {
              type: "object",
              properties: {
                entity_type: { type: "string", enum: ["session", "business_session", "transaction"] },
                entity_uuid: { type: "string", description: "The id of that session or transaction." },
              },
              required: ["entity_type", "entity_uuid"],
            },
          },
          priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"], description: "MEDIUM when left out." },
          assigned_to: { type: "string", description: "The reviewer to assign the case to: the `user_id` of a member (didit_org_list_members)." },
          due_at: { type: "string", description: "The deadline, ISO 8601. Left out, the review policy's own deadline applies when it has one." },
          tags: { type: "array", items: { type: "string" }, description: "Labels to find the case by." },
          blueprint: { type: "string", description: "The uuid of the review policy to open the case under. It must be active." },
          review_duplicates: { type: "boolean", description: "Look for cases already open about the same subject before creating this one." },
          separate_incident_reason: { type: "string", description: "Why a separate case is wanted although one is already open (1,000 characters at most)." },
        },
        required: ["title"],
      },
    },
    access: "write",
    permission: "write:cases", // POST …/cases/ → case_management.py:292
    run: (args) => createCase(args),
  },
  {
    def: {
      name: "didit_case_statistics",
      description:
        "Case analytics for a period (totals, series over time, the queue, outcomes and workload): the last 30 days " +
        "unless both dates are given, two years at most. Every filter narrows the numbers.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          date_from: { type: "string", description: "First day, YYYY-MM-DD. Give it together with date_to." },
          date_to: { type: "string", description: "Last day, YYYY-MM-DD." },
          status: { type: "string", enum: ["OPEN", "AWAITING_USER", "RESOLVED"] },
          priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
          source: {
            type: "string",
            enum: ["MANUAL", "AML_SCREENING", "TRANSACTION_RULE", "WORKFLOW_BUILDER"],
            description: "What opened the cases.",
          },
          scope: { type: "string", enum: ["identity", "transactions"], description: "Only identity cases, or only the ones a transaction rule opened." },
          assigned_to: { type: "string", description: "Only cases assigned to this reviewer (a member's `user_id`)." },
          blueprint: { type: "string", description: "Only cases under this review policy (its uuid)." },
        },
      },
    },
    access: "read",
    permission: "list:cases", // GET …/cases/statistics/ → case_management.py:910
    run: (args) => caseStatistics(args),
  },
  {
    def: {
      name: "didit_case_manage",
      description: "Act on a case: assign, resolve, reopen, escalate, comment, or update.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          case_id: { type: "string" },
          action: { type: "string", enum: ["assign", "resolve", "reopen", "escalate", "comment", "update"] },
          data: { type: "object", description: "Action payload (e.g. {assignee_id}, {comment}, or fields to update)" },
          confirm: {
            type: "boolean",
            description:
              "REQUIRED when filing a SAR (action 'sar'/'file_sar', or any action whose data.status is 'SAR_FILED') - a high-impact regulatory action. Only set after explicit user confirmation of this exact action.",
          },
        },
        required: ["case_id", "action"],
      },
    },
    // Resolves, reopens, escalates or reassigns a case: a client asks before running it.
    access: "destructive",
    permission: "write:cases", // POST …/cases/{id}/{resolve|assign|reopen|escalate}/, PATCH …/cases/{id}/ → case_management.py
    run: (args) => manageCase(args.case_id, args.action, args.data || {}, args.confirm),
  },
];
