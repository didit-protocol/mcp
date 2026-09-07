import { getOrgAppMap, mapWithConcurrency, runForScope, OrgRef, AppRef } from "../orgapp";
import { applyRelativeWindow } from "../dates";
import { apiRequest, orgPath } from "../config";
import { listSessions } from "./sessions";
import { listTransactions } from "./transactions";
import { listCases } from "./cases";
import { listUsers } from "./users";
import { listBusinesses } from "./businesses";
import { listWorkflows, getWorkflow } from "./settings";
import { DiditError } from "../security";

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
  const orgs = map.filter((o) => !organization_id || o.orgId === organization_id);

  // Per-app fan-out for one org (fallback path / vendor path), tagging rows with org + app.
  const fanOutOrg = async (o: OrgRef): Promise<any[]> => {
    const appBatches = await mapWithConcurrency(o.apps, FANOUT_CONCURRENCY, async (a) => {
      try {
        const page = await runForScope(o.orgId, a.appId, () => listFn({ ...filters, limit }));
        return rowsOf(page).map((r) => ({
          ...r,
          organization_id: o.orgId,
          organization_name: o.orgName,
          application_id: a.appId,
          application_name: a.appName,
        }));
      } catch {
        return [] as any[];
      }
    });
    return appBatches.flat();
  };

  // Prefer the org-level endpoint: one query per org, rows already carry app/org attribution.
  if (orgResourcePath) {
    let fellBack = 0;
    const batches = await mapWithConcurrency(orgs, FANOUT_CONCURRENCY, async (o) => {
      try {
        const page = await runForScope(o.orgId, undefined, () =>
          apiRequest(orgPath(orgResourcePath, { organizationId: o.orgId }), {
            params: { ...filters, limit },
          }),
        );
        return rowsOf(page).map((r) => ({
          organization_id: o.orgId,
          organization_name: o.orgName,
          ...r,
        }));
      } catch {
        fellBack++;
        return fanOutOrg(o);
      }
    });
    const merged = batches.flat().sort((x, y) => createdAtMs(y) - createdAtMs(x)).slice(0, limit);
    return {
      results: merged,
      returned: merged.length,
      aggregated: true,
      scanned_orgs: orgs.length,
      via: fellBack ? `org-endpoint (per-app fallback for ${fellBack} org(s))` : "org-endpoint",
    };
  }

  // No org endpoint (vendor directories) → per-app fan-out across every (org, app) pair.
  let skipped = 0;
  const pairs = orgs.flatMap((o) => o.apps.map((a) => ({ o, a })));
  const batches = await mapWithConcurrency(pairs, FANOUT_CONCURRENCY, async ({ o, a }) => {
    try {
      const page = await runForScope(o.orgId, a.appId, () => listFn({ ...filters, limit }));
      return rowsOf(page).map((r) => ({
        ...r,
        organization_id: o.orgId,
        organization_name: o.orgName,
        application_id: a.appId,
        application_name: a.appName,
      }));
    } catch {
      skipped++;
      return [] as any[];
    }
  });
  const merged = batches.flat().sort((x, y) => createdAtMs(y) - createdAtMs(x)).slice(0, limit);
  return {
    results: merged,
    returned: merged.length,
    aggregated: true,
    scanned_apps: pairs.length,
    skipped_apps: skipped,
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
    } catch {
      return null; // 404 here just means "not in this app"
    }
  });
  return hits.filter((h) => h !== null);
}

/** Find workflows (verification-settings) ACROSS every (org, app) in one call. Optionally filter
 *  by `workflow_id` (matches the version uuid OR the stable workflow_id) or `search` (label
 *  substring). Each row is tagged with its org/app — so an agent can locate a workflow by id
 *  without walking dozens of apps. Workflows have no org-level endpoint → per-app fan-out. */
export async function searchWorkflows(args: SearchArgs): Promise<any> {
  const { organization_id, application_id, workflow_id, search, limit: rawLimit } = args;
  const limit = Math.max(1, Math.min(rawLimit ?? 50, MAX_LIMIT));
  const map = await getOrgAppMap();
  const orgs = map.filter((o) => !organization_id || o.orgId === organization_id);
  const pairs = orgs.flatMap((o) =>
    o.apps.filter((a) => !application_id || a.appId === application_id).map((a) => ({ o, a })),
  );
  let skipped = 0;
  const batches = await mapWithConcurrency(pairs, FANOUT_CONCURRENCY, async ({ o, a }) => {
    try {
      const page = await runForScope(o.orgId, a.appId, () => listWorkflows());
      return rowsOf(page).map((r) => ({
        ...r,
        organization_id: o.orgId,
        organization_name: o.orgName,
        application_id: a.appId,
        application_name: a.appName,
      }));
    } catch {
      skipped++;
      return [] as any[];
    }
  });
  let rows = batches.flat();
  if (workflow_id) rows = rows.filter((r) => workflowMatchesId(r, String(workflow_id)));
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((r) => String(r.workflow_label ?? r.label ?? "").toLowerCase().includes(q));
  }
  // The list endpoint doesn't surface every version uuid (drafts, superseded versions), so
  // when an id search misses the listed rows, probe the version endpoint directly per app
  // before reporting no matches.
  if (workflow_id && rows.length === 0) rows = await probeWorkflowDirect(pairs, String(workflow_id));
  return {
    results: rows.slice(0, limit),
    returned: Math.min(rows.length, limit),
    total_matched: rows.length,
    aggregated: true,
    scanned_apps: pairs.length,
    skipped_apps: skipped,
    unlistable_orgs: orgs.filter((o) => o.appsError).length,
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
    found.skipped_apps ? `${found.skipped_apps} application(s) returned errors and could not be scanned` : "",
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
      const page = await runForScope(organizationId, applicationId, () => listWorkflows());
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
