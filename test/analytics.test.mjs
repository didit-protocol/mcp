import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { analytics } from "../dist/tools/analytics.js";

// didit_analytics: what it reads of one application (GET analytics/ and analytics/today/), the filters
// the API takes, and how today's hours are added up across applications.

delete process.env.DIDIT_ACCESS_TOKEN;

const ORG = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const APP_2 = "33333333-3333-4333-8333-333333333333";
const base = (app) => `https://verification.didit.me/v3/organization/${ORG}/application/${app}/analytics/`;

const hours = (at, count) => Array.from({ length: 24 }, (_, hour) => (hour === at ? count : 0));
const TODAY = {
  [APP]: { time_zone: "Europe/Madrid", date: "2026-11-25", current_hour: 10, previous_date: "2026-11-18", hours: hours(9, 4), previous_hours: hours(9, 1), total: 4, previous_total_so_far: 1, outcomes: { approved: 3, in_review: 0, declined: 1 } },
  [APP_2]: { time_zone: "Europe/Madrid", date: "2026-11-25", current_hour: 10, previous_date: "2026-11-18", hours: hours(9, 2), previous_hours: hours(8, 5), total: 2, previous_total_so_far: 5, outcomes: { approved: 2, in_review: 0, declined: 0 } },
};

function backend(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/organizations/me/")) return Response.json([{ uuid: ORG, name: "Acme" }]);
    if (parsed.pathname.endsWith("/applications/")) return Response.json([{ uuid: APP, name: "Live" }, { uuid: APP_2, name: "Second" }]);
    calls.push({ path: `${parsed.origin}${parsed.pathname}`, query: Object.fromEntries(parsed.searchParams) });
    const app = parsed.pathname.split("/application/")[1]?.split("/")[0];
    return Response.json(parsed.pathname.endsWith("/today/") ? TODAY[app] : { request_breakdown: { total_approved: 1 } });
  });
  return calls;
}

const inApp = (args) => requestContext.run({ accessToken: `token-${Math.random()}`, organizationId: ORG, applicationId: APP }, () => analytics(args));

test("the workflow, country and comparison filters reach the API with the window", async (t) => {
  const calls = backend(t);
  await inApp({ organization_id: ORG, application_id: APP, date_from: "2026-11-01", date_to: "2026-11-20", workflow_ids: ["wf-1", "wf-2"], country: "ES,FRA", compare: "same_period_last_year" });
  assert.deepEqual(calls, [{ path: base(APP), query: { start_date: "2026-11-01", end_date: "2026-11-20", workflow_ids: "wf-1,wf-2", country: "ES,FRA", compare: "same_period_last_year" } }]);
});

test("today by hour reads the today route of the one application, in the time zone asked for", async (t) => {
  const calls = backend(t);
  const result = await inApp({ organization_id: ORG, application_id: APP, today_by_hour: true, time_zone: "Europe/Madrid", date_from: "2026-11-01" });
  assert.deepEqual(calls, [{ path: `${base(APP)}today/`, query: { tz: "Europe/Madrid" } }]);
  assert.equal(result.total, 4);
  assert.deepEqual(result.hours, hours(9, 4));
  assert.equal(result.date, "2026-11-25");
  assert.equal(result.request_breakdown, undefined);
});

test("today by hour adds the hours of several applications up, each one listed", async (t) => {
  const calls = backend(t);
  const result = await requestContext.run({ accessToken: `token-${Math.random()}` }, () => analytics({ today_by_hour: true }));
  assert.deepEqual(calls.map(({ path }) => path).sort(), [`${base(APP)}today/`, `${base(APP_2)}today/`].sort());
  assert.deepEqual(result.hours, hours(9, 6));
  assert.deepEqual([result.total, result.previous_total_so_far, result.outcomes], [6, 6, { approved: 5, in_review: 0, declined: 1 }]);
  assert.deepEqual(result.per_app.map(({ application_id, total }) => [application_id, total]).sort(), [[APP, 4], [APP_2, 2]].sort());
  assert.equal(result.scanned_apps, 2);
});
