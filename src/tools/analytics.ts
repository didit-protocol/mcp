import { apiRequest, orgAppPath } from "../config";
import { getOrgAppMap, mapWithConcurrency, runForScope } from "../orgapp";
import { applyRelativeWindow } from "../dates";

// Cross-org/app aggregate analytics. The per-app /analytics/ endpoint already returns a
// time-windowed funnel + status breakdown; there is no org-level endpoint, so this fans
// out over every app the caller can access and merges server-side — answering analytical
// questions ("how many tried phone verification but dropped off in the last 15 days?")
// in ONE tool call. Counts are exact (summed); the funnel exposes per-step "reached".

const FANOUT_CONCURRENCY = 8;

export async function getAnalytics(params: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/analytics/"), { params });
}

function addNumeric(target: Record<string, number>, src: any): void {
  if (!src || typeof src !== "object") return;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "number") target[k] = (target[k] ?? 0) + v;
  }
}

interface FeatureAgg {
  reached: number;
  workflows: number;
}

export async function analytics(args: Record<string, any>): Promise<any> {
  const { organization_id, application_id, include_timeseries, ...rest } = args;
  const params = applyRelativeWindow(rest); // → { date_from, date_to, ... }

  const request_breakdown: Record<string, number> = {};
  const original_status_stats: Record<string, number> = {};
  const warning_stats: Record<string, number> = {};
  const resubmission_stats: Record<string, number> = {};
  const featureAgg: Record<string, FeatureAgg> = {};
  const timeseries: Record<string, Record<string, number>> = {};
  const perApp: any[] = [];
  let sessionsStarted = 0;
  let scanned = 0;
  let skipped = 0;

  function merge(a: any, orgId: string, orgName: string, appId: string, appName: string): void {
    if (!a || typeof a !== "object") return;
    addNumeric(request_breakdown, a.request_breakdown);
    addNumeric(original_status_stats, a.original_status_stats);
    addNumeric(warning_stats, a.warning_stats);
    addNumeric(resubmission_stats, a.resubmission_stats);
    for (const wf of Object.values<any>(a.workflow_funnel_stats ?? {})) {
      sessionsStarted += Number(wf?.total ?? 0);
      for (const [feature, step] of Object.entries<any>(wf?.steps ?? {})) {
        const f = (featureAgg[feature] ??= { reached: 0, workflows: 0 });
        f.reached += Number(step?.reached ?? 0);
        f.workflows += 1;
      }
    }
    if (include_timeseries) {
      for (const dp of a.data_points ?? []) {
        if (!dp?.rounded_date) continue;
        addNumeric((timeseries[dp.rounded_date] ??= {}), dp);
      }
    }
    perApp.push({
      organization_id: orgId,
      organization_name: orgName,
      application_id: appId,
      application_name: appName,
      request_breakdown: a.request_breakdown,
      conversion_rate: a.conversion_rate,
    });
  }

  if (organization_id && application_id) {
    scanned = 1;
    const a = await runForScope(organization_id, application_id, () => getAnalytics(params));
    merge(a, organization_id, "", application_id, "");
  } else {
    const map = await getOrgAppMap();
    const pairs = map
      .filter((o) => !organization_id || o.orgId === organization_id)
      .flatMap((o) => o.apps.map((ap) => ({ o, ap })));
    scanned = pairs.length;
    await mapWithConcurrency(pairs, FANOUT_CONCURRENCY, async ({ o, ap }) => {
      try {
        const a = await runForScope(o.orgId, ap.appId, () => getAnalytics(params));
        merge(a, o.orgId, o.orgName, ap.appId, ap.appName);
      } catch {
        skipped++; // app the caller can't read analytics for — skip
      }
    });
  }

  // Recompute conversion from summed totals (never average per-app rates).
  const approved = request_breakdown.total_approved ?? 0;
  const declined = request_breakdown.total_declined ?? 0;
  const inReview = request_breakdown.total_in_review ?? 0;
  const finished = approved + declined + inReview;
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const conversion_rate = finished > 0 ? round1((approved / finished) * 100) : null;

  const feature_funnel: Record<string, any> = {};
  for (const [feature, v] of Object.entries(featureAgg)) {
    feature_funnel[feature] = {
      reached: v.reached,
      workflows: v.workflows,
      share_of_started: sessionsStarted > 0 ? round1((v.reached / sessionsStarted) * 100) : null,
    };
  }

  return {
    date_window: { date_from: params.date_from, date_to: params.date_to },
    aggregated: !(organization_id && application_id),
    scanned_apps: scanned,
    skipped_apps: skipped,
    sessions_started: sessionsStarted,
    request_breakdown,
    original_status_stats,
    conversion_rate,
    feature_funnel,
    warning_stats,
    resubmission_stats,
    ...(include_timeseries ? { timeseries } : {}),
    per_app: perApp,
    note: "Counts are summed across apps (exact). feature_funnel.reached = sessions that REACHED that step (not per-step pass/fail), so 'tried phone verification' = feature_funnel.PHONE_VERIFICATION.reached and 'dropped off' is inferred from reached vs finished/approved. conversion_rate recomputed = approved/(approved+declined+in_review).",
  };
}
