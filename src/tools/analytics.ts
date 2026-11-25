import { apiRequest, orgAppPath } from "../config";
import { getOrgAppMap, mapWithConcurrency, namedApplications, runForScope } from "../orgapp";
import { leftOutFields, liveReadableScopes, type LeftOutApplication, type LeftOutOrganization } from "../live-access";
import { applyRelativeWindow } from "../dates";
import { DiditError } from "../security";

// Cross-org/app aggregate analytics. The per-app /analytics/ endpoint already returns a
// time-windowed funnel + status breakdown; there is no org-level endpoint, so this fans
// out over every app the caller can access and merges server-side — answering analytical
// questions ("how many tried phone verification but dropped off in the last 15 days?")
// in ONE tool call. Counts are exact (summed); the funnel exposes per-step "reached".

const FANOUT_CONCURRENCY = 8;

export async function getAnalytics(params: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/analytics/"), { params });
}

/** Today's verifications per local hour, against the same weekday last week. */
export async function getAnalyticsToday(tz?: string): Promise<any> {
  return apiRequest(orgAppPath("/analytics/today/"), { params: { tz } });
}

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The window as the analytics endpoint reads it: `start_date` and `end_date` (YYYY-MM-DD, both or
 * neither; without them it answers for the last 30 days). The tool's own `date_from`/`date_to`
 * (and `last_n_days`, already turned into them) were sent verbatim before, so the backend ignored
 * every window and always answered for the last 30 days.
 */
export function analyticsWindow(params: Record<string, any>): { start_date?: string; end_date?: string } {
  const from = typeof params.date_from === "string" && params.date_from ? params.date_from.slice(0, 10) : undefined;
  const to = typeof params.date_to === "string" && params.date_to ? params.date_to.slice(0, 10) : undefined;
  if (!from && !to) return {};
  const end = to ?? isoDay(new Date());
  const start = from ?? isoDay(new Date(new Date(end + "T00:00:00Z").getTime() - 29 * DAY_MS));
  return { start_date: start, end_date: end };
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

type RiskCounts = Record<string, number>;
type WarningStats = Record<string, { total: number; risks: Record<string, RiskCounts> }>;

/** warning_stats is nested ({FEATURE: {total, risks: {CODE: {error, warning, information}}}}). */
function addWarnings(target: WarningStats, src: any): void {
  if (!src || typeof src !== "object") return;
  for (const [feature, stats] of Object.entries<any>(src)) {
    if (!stats || typeof stats !== "object") continue;
    const into = (target[feature] ??= { total: 0, risks: {} });
    if (typeof stats.total === "number") into.total += stats.total;
    for (const [code, counts] of Object.entries<any>(stats.risks ?? {})) addNumeric((into.risks[code] ??= {}), counts);
  }
}

const addHours = (into: number[], src: unknown): number[] =>
  Array.isArray(src) ? src.map((count, hour) => (into[hour] ?? 0) + Number(count ?? 0)) : into;

export async function analytics(args: Record<string, any>): Promise<any> {
  const { organization_id, application_id, application_ids, include_timeseries, today_by_hour, time_zone, ...rest } = args;
  const named = namedApplications(application_id, application_ids);
  const params = applyRelativeWindow(rest); // → { date_from, date_to, ... }
  const { workflow_ids, country, compare } = params;
  // The hourly view is the whole application's: a filter there would be dropped, and its numbers read as filtered.
  const unhourly = today_by_hour ? Object.entries({ workflow_ids, country, compare }).find(([, value]) => value !== undefined) : undefined;
  if (unhourly) {
    throw new DiditError({ code: "bad_request", message: `today_by_hour covers the whole application: ${unhourly[0]} does not apply to it.`, field: unhourly[0] });
  }
  const query = { ...analyticsWindow(params), workflow_ids, country, compare };
  const read = () => (today_by_hour ? getAnalyticsToday(time_zone) : getAnalytics(query));
  const today: Record<string, any> = { hours: [], previous_hours: [], total: 0, previous_total_so_far: 0, outcomes: {} };

  const request_breakdown: Record<string, number> = {};
  const previous_request_breakdown: Record<string, number> = {};
  const original_status_stats: Record<string, number> = {};
  const warning_stats: WarningStats = {};
  const resubmission_stats: Record<string, number> = {};
  const workflow_sessions: Record<string, number> = {};
  let verificationSeconds = 0;
  let verificationCount = 0;
  const featureAgg: Record<string, FeatureAgg> = {};
  const timeseries: Record<string, Record<string, number>> = {};
  const perApp: any[] = [];
  let sessionsStarted = 0;
  let scanned = 0;
  let skipped = 0;
  // What the fan-out left out because the caller's live membership no longer allows it.
  let leftOutOrganizations: LeftOutOrganization[] = [];
  let leftOutApplications: LeftOutApplication[] = [];

  function merge(a: any, orgId: string, orgName: string, appId: string, appName: string): void {
    if (!a || typeof a !== "object") return;
    if (today_by_hour) return mergeToday(a, orgId, orgName, appId, appName);
    addNumeric(request_breakdown, a.request_breakdown);
    addNumeric(previous_request_breakdown, a.previous_request_breakdown);
    addNumeric(original_status_stats, a.original_status_stats);
    addWarnings(warning_stats, a.warning_stats);
    addNumeric(resubmission_stats, a.resubmission_stats);
    const vt = a.verification_time_stats;
    if (vt && typeof vt.overall_avg_seconds === "number" && typeof vt.overall_count === "number" && vt.overall_count > 0) {
      verificationSeconds += vt.overall_avg_seconds * vt.overall_count;
      verificationCount += vt.overall_count;
    }
    for (const [workflowId, wf] of Object.entries<any>(a.workflow_funnel_stats ?? {})) {
      workflow_sessions[workflowId] = (workflow_sessions[workflowId] ?? 0) + Number(wf?.total ?? 0);
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

  function mergeToday(a: any, orgId: string, orgName: string, appId: string, appName: string): void {
    const { hours, previous_hours, total, previous_total_so_far, outcomes, ...day } = a;
    today.hours = addHours(today.hours, hours);
    today.previous_hours = addHours(today.previous_hours, previous_hours);
    addNumeric(today, { total, previous_total_so_far });
    addNumeric(today.outcomes, outcomes);
    Object.assign(today, day);
    perApp.push({ organization_id: orgId, organization_name: orgName, application_id: appId, application_name: appName, total, outcomes });
  }

  if (organization_id && application_id) {
    scanned = 1;
    const a = await runForScope(organization_id, application_id, read);
    merge(a, organization_id, "", application_id, "");
  } else {
    const map = await getOrgAppMap();
    // A call that names an APPLICATION acts in that application only: cut the map to the
    // organization that lists it (when no organization is named) and to that application BEFORE
    // asking the live membership, so one question is asked, not one per organization, an unrelated
    // organization's auth failure cannot fail the call, and left_out_applications never names an
    // application this call does not read (an internal issue review).
    const scopedMap = map
      .filter((o) => {
        if (organization_id && o.orgId !== organization_id) return false;
        return !named || o.apps.some((ap) => named.has(ap.appId.toLowerCase()));
      })
      .map((o) => (named ? { ...o, apps: o.apps.filter((ap) => named.has(ap.appId.toLowerCase())) } : o));
    // The organizations and applications this fan-out is about to read, judged by the caller's
    // LIVE membership: the map is cached for 60 s, so a removal from an organization,
    // or an application taken off the membership, would otherwise keep being read here — and the
    // result would silently merge rows the person may no longer see.
    const live = await liveReadableScopes(scopedMap);
    leftOutOrganizations = live.leftOutOrganizations;
    leftOutApplications = live.leftOutApplications;
    // The map is already cut to the named application, not every application of the organization.
    const pairs = live.readable.flatMap((o) => o.apps.map((ap) => ({ o, ap })));
    scanned = pairs.length;
    await mapWithConcurrency(pairs, FANOUT_CONCURRENCY, async ({ o, ap }) => {
      try {
        const a = await runForScope(o.orgId, ap.appId, read);
        merge(a, o.orgId, o.orgName, ap.appId, ap.appName);
      } catch {
        skipped++; // app the caller can't read analytics for — skip
      }
    });
  }

  if (today_by_hour) {
    return {
      ...today,
      aggregated: !(organization_id && application_id),
      scanned_apps: scanned,
      skipped_apps: skipped,
      per_app: perApp,
      ...leftOutFields(leftOutOrganizations, leftOutApplications),
    };
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
    date_window: { date_from: query.start_date ?? params.date_from, date_to: query.end_date ?? params.date_to },
    aggregated: !(organization_id && application_id),
    scanned_apps: scanned,
    skipped_apps: skipped,
    sessions_started: sessionsStarted,
    request_breakdown,
    previous_request_breakdown,
    original_status_stats,
    conversion_rate,
    feature_funnel,
    warning_stats,
    resubmission_stats,
    workflow_sessions,
    avg_verification_seconds: verificationCount > 0 ? Math.round((verificationSeconds / verificationCount) * 10) / 10 : null,
    ...(include_timeseries ? { timeseries } : {}),
    per_app: perApp,
    ...leftOutFields(leftOutOrganizations, leftOutApplications),
    note: "Counts are summed across apps (exact). feature_funnel.reached = sessions that REACHED that step (not per-step pass/fail), so 'tried phone verification' = feature_funnel.PHONE.reached (step keys: OCR, LIVENESS, FACE_MATCH, AML, POA, PHONE, EMAIL, NFC, DATABASE_VALIDATION, QUESTIONNAIRE, IP_ANALYSIS, AGE_ESTIMATION, KYB_*) and 'dropped off' is inferred from reached vs finished/approved. conversion_rate recomputed = approved/(approved+declined+in_review).",
  };
}
