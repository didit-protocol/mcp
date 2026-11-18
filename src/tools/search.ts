import { getOrgAppMap, mapWithConcurrency, ORG_APP_PROPS, runForScope, OrgRef, AppRef } from "../orgapp";
import { leftOutFields, liveReadableScopes } from "../live-access";
import type { RegisteredTool } from "./registry";
import { LAST_N_DAYS_PROP, SESSION_SEARCH_DESCRIPTION, SESSION_STATUSES } from "./shared-schema";
import { applyRelativeWindow } from "../dates";
import { apiRequest, orgPath, requestContext } from "../config";
import { listSessions } from "./sessions";
import { listTransactions } from "./transactions";
import { listCases } from "./cases";
import { listUsers } from "./users";
import { listBusinesses } from "./businesses";
import { listEveryWorkflow, getWorkflow, isPublishedVersion, labelWorkflowVersion, WORKFLOW_IDS_NOTE } from "./settings";
import { DiditError } from "../security";
import { pageParams } from "../paging";

// Cross-org/app aggregate search in ONE tool call. Where the backend exposes an org-level
// endpoint (sessions/transactions/cases), we query it once per org — each row already
// carries application/organization attribution — and fall back to per-app fan-out per org
// if that endpoint isn't available. Vendor directories (no org endpoint) use per-app
// fan-out across every (org, app) the caller can access. Collapses the model's N+1 walk
// (list orgs → list apps → list-per-app → merge) into one call, the way Linear's
// list_issues / Sentry's search_events span a whole workspace.

const FANOUT_CONCURRENCY = 8;
const MAX_LIMIT = 200;

type ListFn = (params?: Record<string, any>) => Promise<any>;

function rowsOf(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.results)) return payload.results;
  return [];
}

function createdAtMs(row: any): number {
  const v = row?.created_at ?? row?.created ?? row?.timestamp ?? row?.date;
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * A fan-out branch is only skipped when that SCOPE cannot answer: the caller's role has
 * no access to the resource on that application (403), the application/route does not
 * exist there (404/405/501), or the backend failed for that application (5xx). Anything
 * else — a revoked or expired token (401), a filter the backend rejected (400/422), rate
 * limiting or a network failure — is a real error and must reach the caller. Swallowing
 * those reported "no sessions" for a revoked token and an empty result for a filter the
 * backend refused. A search whose every scope failed (not merely some) surfaces the
 * failure too; see everyLeafFailed below.
 */
function isScopeGap(error: unknown): boolean {
  if (!(error instanceof DiditError)) return false;
  const status = error.shape.status ?? 0;
  return status === 403 || status === 404 || status === 405 || status >= 500;
}

function isDenied(error: unknown): boolean {
  return error instanceof DiditError && (error.shape.status === 403 || error.shape.code === "forbidden");
}

/** Every reachable scope refused for permission: an empty success would claim nothing exists. */
function allDeniedError(attempts: number, firstDenial: DiditError): DiditError {
  return new DiditError({
    code: "forbidden",
    message:
      `Your role cannot read this resource in any of the ${attempts} application(s) the search reached, ` +
      `so no result can be shown (the backend said: ${firstDenial.shape.message}).`,
    hint: "Ask an organization owner or admin to grant the read/list permission for this resource, then retry. This is not an empty result.",
    status: 403,
  });
}

interface SearchArgs {
  organization_id?: string;
  application_id?: string;
  limit?: number;
  [filter: string]: any;
}

async function aggregateSearch(
  listFn: ListFn,
  args: SearchArgs,
  orgResourcePath?: string,
): Promise<any> {
  const { organization_id, application_id, limit: rawLimit, ...rawFilters } = args;
  const filters = applyRelativeWindow(rawFilters); // last_n_days → date_from/date_to
  const limit = Math.max(1, Math.min(rawLimit ?? 20, MAX_LIMIT));

  // Fully-scoped → a single per-app call, no fan-out.
  if (organization_id && application_id) {
    const page = await runForScope(organization_id, application_id, () =>
      listFn({ ...filters, limit }),
    );
    return { results: rowsOf(page).slice(0, limit), aggregated: false, scanned_apps: 1, skipped_apps: 0 };
  }

  const map = await getOrgAppMap();
  // A call that names an APPLICATION acts in that application only: cut the map to the organization
  // that lists it (when no organization is named) and to that application BEFORE asking the live
  // membership. One question, not one per organization; another organization's auth failure cannot
  // fail the call; and liveReadableScopes judges, and can report in left_out_applications, only a
  // scope the call actually reads (an internal issue review).
  const namedApp = application_id ? String(application_id).toLowerCase() : undefined;
  const scopedMap = map
    .filter((o) => {
      if (organization_id && o.orgId !== organization_id) return false;
      return !namedApp || o.apps.some((a) => a.appId.toLowerCase() === namedApp);
    })
    .map((o) => (namedApp ? { ...o, apps: o.apps.filter((a) => a.appId.toLowerCase() === namedApp) } : o));
  // Every organization AND application this fan-out is about to read, minus the ones the caller's
  // live membership no longer allows: the map is cached for 60 s, so a removal from an
  // organization, or an application taken off the membership, would otherwise keep returning its
  // rows for up to a minute. One question per organization, in parallel, and no row is fetched
  // from an organization or an application left out.
  const { readable, leftOutOrganizations, leftOutApplications, droppedApps } = await liveReadableScopes(scopedMap);
  // The map is already cut to the application the call named, so no other application's rows can be
  // returned in place of the one asked for (an internal issue review).
  const orgs = readable;

  // Leaf calls that actually ran, and how many of them a role refused (403). Every scope
  // refused must not read as "no results" — see allDeniedError.
  let leafAttempts = 0;
  let deniedLeaves = 0;
  let failedLeaves = 0;
  let firstDenial: DiditError | undefined;
  let firstFailure: DiditError | undefined;
  const noteGap = (error: unknown): void => {
    if (!isScopeGap(error)) throw error;
    if (isDenied(error)) {
      deniedLeaves++;
      firstDenial ??= error as DiditError;
    } else if (((error as DiditError).shape.status ?? 0) >= 500) {
      // A 404/405 is that route being absent from this application: empty, not a failure.
      failedLeaves++;
      firstFailure ??= error as DiditError;
    }
  };
  /** No row came back and no scope answered: a permission refusal or a failure, never "empty". */
  const everyLeafFailed = (): DiditError | undefined => {
    if (leafAttempts === 0 || deniedLeaves + failedLeaves !== leafAttempts) return undefined;
    if (deniedLeaves === leafAttempts) return firstDenial ? allDeniedError(leafAttempts, firstDenial) : undefined;
    return firstFailure;
  };

  // Per-app fan-out for one org (fallback path / vendor path), tagging rows with org + app.
  const fanOutOrg = async (o: OrgRef): Promise<any[]> => {
    const appBatches = await mapWithConcurrency(o.apps, FANOUT_CONCURRENCY, async (a) => {
      leafAttempts++;
      try {
        const page = await runForScope(o.orgId, a.appId, () => listFn({ ...filters, limit }));
        return rowsOf(page).map((r) => ({
          ...r,
          organization_id: o.orgId,
          organization_name: o.orgName,
          application_id: a.appId,
          application_name: a.appName,
        }));
      } catch (error) {
        noteGap(error);
        return [] as any[];
      }
    });
    return appBatches.flat();
  };

  // Prefer the org-level endpoint: one query per org, rows already carry app/org attribution.
  // Not for an API key connection: the organization-wide routes only answer to a person, and its
  // one application is exactly what the per-app fan-out below reads.
  if (orgResourcePath && !namedApp && !requestContext.getStore()?.apiKey) {
    let fellBack = 0;
    const batches = await mapWithConcurrency(orgs, FANOUT_CONCURRENCY, async (o) => {
      // A scope that lost an application must take the per-app path: the organization-wide endpoint
      // answers for EVERY application of the organization, one the membership no longer opens
      // included, and the result says nothing was read there. Fan out over the applications it may
      // still open instead (an internal issue review).
      if (droppedApps.get(o.orgId.toLowerCase())?.size) return fanOutOrg(o);
      try {
        const page = await runForScope(o.orgId, undefined, () =>
          apiRequest(orgPath(orgResourcePath, { organizationId: o.orgId }), {
            params: { ...filters, limit },
          }),
        );
        // A scope that lost an application takes the per-app path above instead, so the
        // organization-wide endpoint is only read where every application it answers for is open,
        // and no row of a lost application is fetched.
        return rowsOf(page).map((r) => ({
          organization_id: o.orgId,
          organization_name: o.orgName,
          ...r,
        }));
      } catch (error) {
        if (!isScopeGap(error)) throw error; // a revoked token or a bad filter is fatal
        fellBack++;
        return fanOutOrg(o);
      }
    });
    const merged = batches.flat().sort((x, y) => createdAtMs(y) - createdAtMs(x)).slice(0, limit);
    const fatal = merged.length ? undefined : everyLeafFailed();
    if (fatal) throw fatal;
    return {
      results: merged,
      returned: merged.length,
      aggregated: true,
      scanned_orgs: orgs.length,
      via: fellBack ? `org-endpoint (per-app fallback for ${fellBack} org(s))` : "org-endpoint",
      ...leftOutFields(leftOutOrganizations, leftOutApplications),
    };
  }

  // No org endpoint (vendor directories) → per-app fan-out across every (org, app) pair.
  let skipped = 0;
  const pairs = orgs.flatMap((o) => o.apps.map((a) => ({ o, a })));
  const batches = await mapWithConcurrency(pairs, FANOUT_CONCURRENCY, async ({ o, a }) => {
    leafAttempts++;
    try {
      const page = await runForScope(o.orgId, a.appId, () => listFn({ ...filters, limit }));
      return rowsOf(page).map((r) => ({
        ...r,
        organization_id: o.orgId,
        organization_name: o.orgName,
        application_id: a.appId,
        application_name: a.appName,
      }));
    } catch (error) {
      noteGap(error);
      skipped++;
      return [] as any[];
    }
  });
  const merged = batches.flat().sort((x, y) => createdAtMs(y) - createdAtMs(x)).slice(0, limit);
  const fatal = merged.length ? undefined : everyLeafFailed();
  if (fatal) throw fatal;
  return {
    results: merged,
    returned: merged.length,
    aggregated: true,
    scanned_apps: pairs.length,
    skipped_apps: skipped,
    ...leftOutFields(leftOutOrganizations, leftOutApplications),
  };
}

export async function searchSessions(args: SearchArgs): Promise<any> {
  return aggregateSearch(listSessions as ListFn, args, "/sessions/");
}

export async function searchTransactions(args: SearchArgs): Promise<any> {
  return aggregateSearch(listTransactions as ListFn, args, "/transactions/");
}

export async function searchCases(args: SearchArgs): Promise<any> {
  return aggregateSearch(listCases as ListFn, args, "/cases/");
}

export async function searchVendorUsers(args: SearchArgs): Promise<any> {
  return aggregateSearch(listUsers as ListFn, args);
}

export async function searchVendorBusinesses(args: SearchArgs): Promise<any> {
  return aggregateSearch(listBusinesses as ListFn, args);
}

const workflowMatchesId = (w: any, id: string): boolean =>
  w?.uuid === id || w?.workflow_id === id || w?.id === id;

const isWorkflowHit = (wf: any): boolean => Boolean(wf && (wf.uuid || wf.workflow_id));

const VERSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL_CANDIDATES = 10;
const workflowLabel = (w: any): string => String(w?.workflow_label ?? w?.label ?? "");
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const candidateLine = (w: any): string => `"${workflowLabel(w)}" → ${w.workflow_id ?? w.uuid}`;

/** Direct per-app probe of the version endpoint (GET /verification-settings/{uuid}/) — finds
 *  version uuids the list endpoint hides (drafts, superseded versions a session may still
 *  reference), tagged with org/app like the list rows. */
async function probeWorkflowDirect(
  pairs: { o: OrgRef; a: AppRef }[],
  workflowId: string,
): Promise<any[]> {
  const hits = await mapWithConcurrency(pairs, FANOUT_CONCURRENCY, async ({ o, a }) => {
    try {
      const wf = await runForScope(o.orgId, a.appId, () => getWorkflow(workflowId));
      return isWorkflowHit(wf)
        ? {
            ...wf,
            organization_id: o.orgId,
            organization_name: o.orgName,
            application_id: a.appId,
            application_name: a.appName,
          }
        : null;
    } catch (error) {
      if (!isScopeGap(error)) throw error; // a revoked token must not read as "not in this app"
      return null; // 404 here just means "not in this app"
    }
  });
  return hits.filter((h) => h !== null);
}

/** The list shows one row per workflow: its live (latest published) version, or its draft when
 *  nothing is published. undefined when that workflow's row was not listed. */
function liveListedVersion(listed: any[], wf: any): any {
  const row = listed.find((r) => Boolean(wf.workflow_id) && r.workflow_id === wf.workflow_id && r.application_id === wf.application_id);

  return row && (isPublishedVersion(row) ? row : null);
}

/** Find workflows (verification-settings) ACROSS every (org, app) in one call. Optionally filter
 *  by `workflow_id` (matches the version uuid OR the stable workflow_id) or `search` (label
 *  substring). Each row is tagged with its org/app — so an agent can locate a workflow by id
 *  without walking dozens of apps. Workflows have no org-level endpoint → per-app fan-out. */
export async function searchWorkflows(args: SearchArgs & { offset?: unknown }): Promise<any> {
  const { organization_id, application_id, workflow_id, search, limit: rawLimit } = args;
  const limit = Math.max(1, Math.min(rawLimit ?? 50, MAX_LIMIT));
  // didit_workflow_list answers from here when it spans applications, and it takes `offset`.
  const offset = pageParams({ offset: args.offset }).offset ?? 0;
  const map = await getOrgAppMap();
  // As in aggregateSearch: a call that names an application reads that application only — the map
  // is cut to the organization that lists it (when no organization is named) and to the application
  // before asking the live membership, so one question is asked and left_out_applications names only
  // a scope the call reads. When both ids are named, the application filter still applies: the
  // organization's other applications are not this call's to read (an internal issue review).
  const namedApp = application_id ? String(application_id).toLowerCase() : undefined;
  const scopedMap = map
    .filter((o) => {
      if (organization_id && o.orgId !== organization_id) return false;
      return !namedApp || o.apps.some((a) => a.appId.toLowerCase() === namedApp);
    })
    .map((o) => (namedApp ? { ...o, apps: o.apps.filter((a) => a.appId.toLowerCase() === namedApp) } : o));
  // Ask the caller's live membership for each organization before reading it, and leave out the
  // organizations and applications it no longer allows.
  const { readable: orgs, leftOutOrganizations, leftOutApplications } = await liveReadableScopes(scopedMap);
  const pairs = orgs.flatMap((o) => o.apps.map((a) => ({ o, a })));
  let skipped = 0;
  let unfinished = 0;
  let leafAttempts = 0;
  let deniedLeaves = 0;
  let firstDenial: DiditError | undefined;
  const batches = await mapWithConcurrency(pairs, FANOUT_CONCURRENCY, async ({ o, a }) => {
    leafAttempts++;
    try {
      // Every page: the API lists 20 workflows at a time, and a workflow this search does not
      // see cannot be found by its id or its label.
      const all = await runForScope(o.orgId, a.appId, () => listEveryWorkflow());
      if (!all.complete) unfinished++;
      return all.rows.map((r) => ({
        ...r,
        organization_id: o.orgId,
        organization_name: o.orgName,
        application_id: a.appId,
        application_name: a.appName,
      }));
    } catch (error) {
      if (!isScopeGap(error)) throw error;
      if (isDenied(error)) {
        deniedLeaves++;
        firstDenial ??= error as DiditError;
      }
      skipped++;
      return [] as any[];
    }
  });
  // Every application refused this role: say so instead of reporting "no workflows".
  if (firstDenial && deniedLeaves === leafAttempts) throw allDeniedError(leafAttempts, firstDenial);
  const listed = batches.flat();
  let rows = listed.map((r) => labelWorkflowVersion(r, isPublishedVersion(r) ? r : null));
  if (workflow_id) rows = rows.filter((r) => workflowMatchesId(r, String(workflow_id)));
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((r) => String(r.workflow_label ?? r.label ?? "").toLowerCase().includes(q));
  }
  // The list endpoint doesn't surface every version uuid (drafts, superseded versions), so
  // when an id search misses the listed rows, probe the version endpoint directly per app
  // before reporting no matches.
  if (workflow_id && rows.length === 0) {
    rows = (await probeWorkflowDirect(pairs, String(workflow_id))).map((wf) => labelWorkflowVersion(wf, liveListedVersion(listed, wf)));
  }
  const results = rows.slice(offset, offset + limit);
  return {
    results,
    ids_note: WORKFLOW_IDS_NOTE,
    returned: results.length,
    total_matched: rows.length,
    ...(offset ? { offset } : {}),
    aggregated: true,
    scanned_apps: pairs.length,
    skipped_apps: skipped,
    ...(unfinished ? { partly_read_apps: unfinished } : {}),
    unlistable_orgs: orgs.filter((o) => o.appsError).length,
    ...leftOutFields(leftOutOrganizations, leftOutApplications),
  };
}

export interface WorkflowScope {
  organizationId: string;
  applicationId: string;
  workflow: any;
  /** Set when `workflow_id` was a label/slug that resolved to exactly one workflow. */
  resolved_from?: string;
}

const scanGaps = (found: any): string[] =>
  [
    typeof found.left_out_note === "string" ? found.left_out_note : "",
    found.skipped_apps ? `${found.skipped_apps} application(s) returned errors and could not be scanned` : "",
    found.partly_read_apps ? `${found.partly_read_apps} application(s) have more workflows than could be read` : "",
    found.unlistable_orgs ? `the applications of ${found.unlistable_orgs} organization(s) could not be listed` : "",
  ].filter(Boolean);

function notFoundError(workflowId: string, found: any): Error {
  const gaps = scanGaps(found);
  return new Error(
    `Workflow ${workflowId} was not found in any of your applications. ` +
      (gaps.length ? `Caveat: ${gaps.join(", and ")} — the workflow may live there. ` : "") +
      `Run didit_workflow_search to list workflows, or verify you're connected to the right environment (staging vs production).`,
  );
}

/** Zero or several label matches: list the candidates (label → id) so the model picks one
 *  explicitly — the alternative, guessing, is how a wrong workflow gets edited. */
function labelMismatch(label: string, rows: any[], exact: any[]): DiditError {
  const partial = rows.filter((r) => slug(workflowLabel(r)).includes(slug(label)));
  const candidates = (exact.length ? exact : partial.length ? partial : rows).slice(0, MAX_LABEL_CANDIDATES);
  return new DiditError({
    code: "bad_request",
    field: "workflow_id",
    message: exact.length
      ? `Several workflows are labelled "${label}" — pass the workflow_id of the one you mean.`
      : `No workflow is labelled "${label}". workflow_id takes a workflow uuid, not a label or a node id.`,
    hint: candidates.length
      ? `Candidates (label → workflow_id): ${candidates.map(candidateLine).join("; ")}. Ask the user if unsure.`
      : "Run didit_workflow_search to list workflows.",
  });
}

/** A non-uuid `workflow_id` is a label or slug the model typed ("adaptive-age-estimation") or a
 *  node id ("feature_ocr"; prod 1-4 Sep: 36 calls). Resolve by EXACT label/slug match inside the
 *  caller's scope; anything else lists the candidates instead of guessing. */
async function resolveWorkflowByLabel(label: string, organizationId?: string, applicationId?: string): Promise<WorkflowScope> {
  const found = await searchWorkflows({ organization_id: organizationId, application_id: applicationId, limit: MAX_LIMIT });
  const rows: any[] = found.results ?? [];
  const exact = rows.filter((r) => slug(workflowLabel(r)) === slug(label));
  // An incomplete scan cannot prove the label is unknown — keep the not-found caveat instead.
  if (!exact.length && scanGaps(found).length) throw notFoundError(label, found);
  if (exact.length !== 1) throw labelMismatch(label, rows, exact);
  const [workflow] = exact;
  return { organizationId: workflow.organization_id, applicationId: workflow.application_id, workflow, resolved_from: label };
}

/** Tag a tool result with how a label was resolved, so the model sees which workflow it got. */
export function withWorkflowResolution<R>(result: R, scope: WorkflowScope): R {
  if (!scope.resolved_from || !result || typeof result !== "object" || Array.isArray(result)) return result;
  const { workflow: wf, resolved_from } = scope;
  const workflow_resolved = { from: resolved_from, workflow_id: wf.workflow_id ?? wf.uuid, label: workflowLabel(wf) };
  return { ...result, workflow_resolved } as R;
}

/** Resolve the (org, app) + version row that owns a workflow id, for the graph tools. When the
 *  caller already knows the org/app, a single scoped list avoids the cross-app fan-out. */
export async function resolveWorkflowScope(
  workflowId: string,
  organizationId?: string,
  applicationId?: string,
): Promise<WorkflowScope> {
  if (organizationId && applicationId) {
    // a) Direct version fetch — resolves a specific version uuid, including DRAFTs that the list
    //    endpoint doesn't surface (e.g. a draft just created by set_graph).
    try {
      const wf = await runForScope(organizationId, applicationId, () => getWorkflow(workflowId));
      if (isWorkflowHit(wf)) {
        return {
          organizationId,
          applicationId,
          workflow: { ...wf, organization_id: organizationId, application_id: applicationId },
        };
      }
    } catch {
      /* not a settings uuid (likely the stable workflow_id) — try the list next */
    }
    // b) Stable workflow_id → its current/listed version.
    try {
      const page = await runForScope(organizationId, applicationId, async () => (await listEveryWorkflow()).rows);
      const row = rowsOf(page).find((w) => workflowMatchesId(w, workflowId));
      if (row) {
        return {
          organizationId,
          applicationId,
          workflow: { ...row, organization_id: organizationId, application_id: applicationId },
        };
      }
    } catch {
      /* fall through to cross-app fan-out */
    }
  }
  const found = await searchWorkflows({ workflow_id: workflowId, limit: 5 } as SearchArgs);
  const rows: any[] = found.results ?? [];
  // Prefer an exact version-uuid match, else the stable workflow_id match (newest/published).
  const exact = rows.find((r) => r.uuid === workflowId) ?? rows[0];
  if (!exact) {
    if (!VERSION_UUID_RE.test(workflowId)) return resolveWorkflowByLabel(workflowId, organizationId, applicationId);
    throw notFoundError(workflowId, found);
  }
  return { organizationId: exact.organization_id, applicationId: exact.application_id, workflow: exact };
}

// ── The search tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const SEARCH_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_session_search",
      description: `Search verification sessions ACROSS ALL your apps and organizations in a single call — the efficient way to answer "the last 5 in-review sessions across my apps". Aggregates server-side and returns newest matches first, each tagged with its organization/application. Omit organization_id/application_id to span everything; pass them to narrow scope.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          status: { type: "string", description: `Filter by session status (${SESSION_STATUSES}). Several statuses separated by commas match any of them, e.g. "Not Started,In Progress".` },
          session_kind: { type: "string", enum: ["user", "business", "all"], description: "KYC (user), KYB (business), or all" },
          workflow_id: { type: "string", description: "Filter by workflow UUID" },
          search: { type: "string", description: SESSION_SEARCH_DESCRIPTION },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging across apps (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    access: "read",
    permission: ["list:sessions", "read:sessions"], // GET /organization/{org}/sessions/ → application.py:448
    routingIds: true,
    run: (args) => searchSessions(args),
  },
  {
    def: {
      name: "didit_transaction_search",
      description:
        "Search transaction-monitoring (AML) transactions ACROSS ALL your apps and organizations in one call. Omit organization_id/application_id to span everything; pass them to narrow. Returns newest first, each tagged with its org/app.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: { type: "string", description: "Filter by transaction status" },
          search: { type: "string", description: "Free-text search" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    access: "read",
    permission: ["list:transactions", "read:transactions"], // GET /organization/{org}/transactions/ → transactions.py:278
    routingIds: true,
    run: (args) => searchTransactions(args),
  },
  {
    def: {
      name: "didit_case_search",
      description:
        "Search case-management cases ACROSS ALL your apps and organizations in one call. Omit organization_id/application_id to span everything; pass them to narrow. Returns newest first, each tagged with its org/app.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: { type: "string", description: "Filter by case status" },
          search: { type: "string", description: "Free-text search" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    access: "read",
    permission: ["list:cases", "read:cases"], // GET /organization/{org}/cases/ → case_management.py:264
    routingIds: true,
    run: (args) => searchCases(args),
  },
  {
    def: {
      name: "didit_vendor_user_search",
      description:
        "Find vendor users (your end customers) ACROSS ALL your apps and organizations in one call — e.g. locate a customer by vendor_data/email/name without knowing which app they're in. Omit organization_id/application_id to span everything; pass them to narrow. Each hit is tagged with its org/app.",
      inputSchema: {
        type: "object" as const,
        properties: {
          search: { type: "string", description: "Free-text search (name, email, vendor_data)" },
          vendor_data: { type: "string", description: "Filter by your customer identifier" },
          status: { type: "string", description: "Filter by vendor-user status" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    access: "read",
    permission: ["list:users", "read:users"], // per-app fan-out over the list endpoint
    routingIds: true,
    run: (args) => searchVendorUsers(args),
  },
  {
    def: {
      name: "didit_vendor_business_search",
      description:
        "Find vendor businesses (KYB companies) ACROSS ALL your apps and organizations in one call. Omit organization_id/application_id to span everything; pass them to narrow. Each hit is tagged with its org/app.",
      inputSchema: {
        type: "object" as const,
        properties: {
          search: { type: "string", description: "Free-text search (company name, registration number, vendor_data)" },
          vendor_data: { type: "string", description: "Filter by your business identifier" },
          status: { type: "string", description: "Filter by vendor-business status" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    access: "read",
    permission: ["list:businesses", "read:businesses"], // per-app fan-out over the list endpoint
    routingIds: true,
    run: (args) => searchVendorBusinesses(args),
  },
];
