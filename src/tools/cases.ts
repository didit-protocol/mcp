import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { searchCases } from "./search";
import { CASE_FILTER_PROPS } from "./shared-schema";
import { ORG_APP_PROPS } from "../orgapp";
import { PAGE_PROPS, pageParams } from "../paging";
import { assertBoolean, pathSegment, DiditError } from "../security";

// Case management — org/app-scoped console resource. Read/create are dedicated tools;
// the many per-case actions fold into one action-dispatch tool to keep the surface small.

const cid = (id: string) => pathSegment(id, "case_id");

/**
 * The filters as the list endpoints name them: the statuses travel as `status__in`, and a window in days. One value
 * the list cannot read drops every filter with it, so a date that carries a time is cut to its day.
 */
export function caseListParams({ status, date_from, date_to, cursor, ...filters }: Record<string, any> = {}): Record<string, any> {
  if (cursor !== undefined) {
    throw new DiditError({ code: "bad_request", message: "The case list has no cursor: page with limit and offset.", field: "cursor" });
  }
  const day = (date: unknown) => (typeof date === "string" ? date.slice(0, 10) : date);
  const given = { date_from: day(date_from), date_to: day(date_to), status__in: status === undefined ? undefined : String(status).toUpperCase() };

  return { ...filters, ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) };
}

export async function listCases(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/cases/"), { params: caseListParams(params) });
}

const CASE_PARTS = ["notes", "links", "events", "checklist", "aml"];

/** A case, with the parts of it that have an endpoint of their own when `include` names them. */
export async function getCase(caseId: string, include: unknown = []): Promise<any> {
  const parts: string[] = [...new Set(Array.isArray(include) ? include : [include])];
  assertKnown(parts, CASE_PARTS, "include");
  const path = `/cases/${cid(caseId)}/`;
  const [found, ...read] = await Promise.all([path, ...parts.map((part) => `${path}${part}/`)].map((each) => apiRequest(orgAppPath(each))));

  return parts.length ? { ...found, included: Object.fromEntries(parts.map((part, i) => [part, read[i]])) } : found;
}

function assertKnown(values: unknown[], allowed: string[], field: string): void {
  const unknown = values.find((value) => !allowed.includes(String(value)));
  if (unknown === undefined) return;
  throw new DiditError({ code: "bad_request", message: `${field} does not take ${String(unknown)}.`, field, allowed });
}

const CASE_CATALOGS: Record<string, string> = {
  reviewers: "/cases/reviewers/",
  teams: "/cases/teams/",
  blueprints: "/cases/blueprints/",
  presets: "/cases/blueprints/presets/",
  report_templates: "/report-templates/",
};

export async function listCaseCatalog(args: Record<string, any>): Promise<any> {
  assertKnown([args.kind], Object.keys(CASE_CATALOGS), "kind");

  return apiRequest(orgAppPath(CASE_CATALOGS[args.kind]), { params: pageParams(args) });
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

interface CaseAction {
  /** The path under the case. */
  path: (data: Record<string, any>) => string;
  method?: "PATCH" | "DELETE";
  /** What the endpoint reads: it would ignore anything else. */
  fields?: string[];
  /** Why it needs confirm:true. */
  decides?: string;
}

// Approving a resolution is not here: the API takes it from a second person only, and refuses an agent's token.
const CASE_ACTIONS: Record<string, CaseAction> = {
  assign: { path: () => "assign/", fields: ["assignee_user_id", "assignee_email", "assignee_name"] },
  update: { path: () => "", method: "PATCH", fields: ["title", "priority", "due_at", "tags", "team"] },
  resolve: { path: () => "resolve/", fields: ["resolution", "note", "checker"], decides: "Resolving a case records its finding." },
  reopen: { path: () => "reopen/" },
  escalate: { path: () => "escalate/", fields: ["comment"] },
  request_info: { path: () => "request-info/" },
  note: { path: () => "notes/", fields: ["comment", "reply_to", "mentioned_emails", "is_internal", "tags"] },
  link: { path: () => "links/", fields: ["entity_type", "entity_uuid"] },
  unlink: { path: ({ link_uuid }) => `links/${pathSegment(link_uuid, "link_uuid")}/`, method: "DELETE", fields: ["link_uuid"] },
  checklist: { path: ({ item_uuid }) => `checklist/${pathSegment(item_uuid, "item_uuid")}/`, method: "PATCH", fields: ["item_uuid", "is_completed"] },
  transfer: { path: () => "transfer/", fields: ["target_blueprint"] },
  entity_action: { path: () => "entity-actions/", fields: ["action", "status", "tags", "note"], decides: "An entity action changes the subject of the case." },
  reject_approval: { path: () => "reject-approval/", fields: ["notes"], decides: "Rejecting a resolution sends the case back." },
};
/** Ids of the path, never of the body. */
const PATH_IDS = ["link_uuid", "item_uuid"];

export async function manageCase(
  caseId: string,
  requested: unknown,
  data: Record<string, any> = {},
  confirm?: unknown,
): Promise<any> {
  // `comment` is what the note action was called before.
  const name = requested === "comment" ? "note" : String(requested);
  assertKnown([name], Object.keys(CASE_ACTIONS), "action");
  const { path, method, fields = [], decides } = CASE_ACTIONS[name];
  assertBoolean(confirm, "confirm");
  if (decides && confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: decides,
      field: "confirm",
      hint: "Show the person the exact action, and re-call with confirm:true only once they have explicitly approved it.",
    });
  }
  assertKnown(Object.keys(data), fields, "data");
  const body = Object.fromEntries(Object.entries(data).filter(([key]) => !PATH_IDS.includes(key)));

  return apiRequest(orgAppPath(`/cases/${cid(caseId)}/`) + path(data), {
    method: method ?? "POST",
    ...(method === "DELETE" ? {} : { json: body }),
  });
}

// ── The case tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const CASE_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_case_list",
      description: "List investigation/compliance cases for ONE app; with multiple apps (or no scope) it auto-spans all your apps. For a cross-app query prefer didit_case_search.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          status: { type: "string", description: "OPEN, AWAITING_USER, RESOLVED, comma-separated" },
          ...CASE_FILTER_PROPS,
          search: { type: "string", description: "Title, case number, tag or subject" },
          date_from: { type: "string", description: "YYYY-MM-DD" },
          date_to: { type: "string", description: "YYYY-MM-DD" },
          ordering: { type: "string", enum: ["-created_at", "created_at", "due_at", "-due_at"] },
          ...PAGE_PROPS,
        },
      },
    },
    access: "read",
    permission: ["list:cases", "read:cases"], // GET …/cases/ → case_management.py:429
    run: (args) => listCases(args),
    spanAllApplications: (args) => searchCases(args),
  },
  {
    def: {
      name: "didit_case_get",
      description: "Get a case with its details.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          case_id: { type: "string" },
          include: { type: "array", items: { type: "string", enum: CASE_PARTS }, description: "Also read these, under `included`" },
        },
        required: ["case_id"],
      },
    },
    access: "read",
    permission: ["read:cases", "list:cases"], // GET …/cases/{id}/ → case_management.py:545
    run: (args) => getCase(args.case_id, args.include),
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
    permission: ["list:cases", "read:cases"], // GET …/cases/statistics/ → case_management.py:910
    run: (args) => caseStatistics(args),
  },
  {
    def: {
      name: "didit_case_manage",
      description:
        "Act on a case. Fields of `data` by action: assign assignee_user_id (null unassigns); update title, priority, due_at, tags, team; " +
        "resolve resolution, note, checker; escalate comment; note comment, reply_to, mentioned_emails, is_internal; link entity_type, " +
        "entity_uuid; unlink link_uuid; checklist item_uuid, is_completed; transfer target_blueprint; entity_action (on the case's subject) action, status, " +
        "tags, note; reject_approval notes; reopen and request_info (waits for the person) take none. A pending resolution is approved in the console, by a second person.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          case_id: { type: "string" },
          action: { type: "string", enum: Object.keys(CASE_ACTIONS) },
          data: {
            type: "object",
            properties: {
              assignee_user_id: { type: ["string", "null"] },
              priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
              resolution: { type: "string", enum: ["FALSE_POSITIVE", "VALID_THREAT", "INCONCLUSIVE", "REQUIREMENTS_NOT_MET", "REQUIREMENTS_SATISFIED"] },
              entity_type: { type: "string", enum: ["session", "business_session", "transaction"] },
              action: { type: "string", enum: ["set_status", "add_tags", "add_note", "add_to_blocklist"] },
            },
          },
          confirm: {
            type: "boolean",
            description: "REQUIRED true for resolve, entity_action and reject_approval. Only set after explicit user confirmation of this exact action.",
          },
        },
        required: ["case_id", "action"],
      },
    },
    // Resolves, reopens, escalates or reassigns a case: a client asks before running it.
    access: "destructive",
    permission: "write:cases", // POST …/cases/{id}/{action}/, PATCH …/cases/{id}/ → case_management.py
    run: (args) => manageCase(args.case_id, args.action, args.data || {}, args.confirm),
  },
  {
    def: {
      name: "didit_case_catalog_list",
      description:
        "The records a case refers to: reviewers (assignee and checker), teams, blueprints (review policies), presets (policies to install) " +
        "or report_templates (regulatory reports).",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, kind: { type: "string", enum: Object.keys(CASE_CATALOGS) }, ...PAGE_PROPS },
        required: ["kind"],
      },
    },
    access: "read",
    permission: ["list:cases", "read:cases"], // GET …/cases/{reviewers|teams|blueprints}/ → case_routing.py, …/report-templates/ → regulatory_reports.py:398
    run: (args) => listCaseCatalog(args),
  },
];
