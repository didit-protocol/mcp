import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * didit_session_list's `count` stops at 100 (the backend's bounded COUNT). Staging, 2026-11-04:
 * "How many sessions are in review?" read `count: 100` off a one-row page and Ask Didit answered
 * 100 while the console's Needs review tab said 266. A capped count now carries the exact total
 * from the console's own tab counts, or says plainly that it is a lower bound.
 */

const { listSessions } = await import("../dist/tools/sessions.js");
const { requestContext } = await import("../dist/config.js");

const SCOPE = { accessToken: "tok-count", organizationId: "org-1", applicationId: "app-1" };
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function backend({ count, counts, countsStatus = 200 }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ pathname, params: Object.fromEntries(searchParams), headers: init.headers });
    if (pathname.endsWith("/sessions/counts/")) return json(counts ?? { detail: "busy" }, countsStatus);
    return json({ count, next: count > 1 ? "next-page" : null, results: [{ session_id: "s-1" }] });
  };
  return calls;
}

const run = (params) => requestContext.run(SCOPE, () => listSessions(params));

test("a capped in-review count carries the exact total from the tab counts", async () => {
  const calls = backend({
    count: 100,
    counts: { views: { needs_review: 266, all: 1884, approved: 1020, declined: 80 }, count_cap: 10000 },
  });

  const result = await run({ organization_id: "org-1", application_id: "app-1", status: "In Review", limit: "1" });

  assert.equal(result.count, 100);
  assert.equal(result.total_count, 266);
  assert.equal(result.count_is_lower_bound, undefined);
  const counts = calls.find((call) => call.pathname.endsWith("/sessions/counts/"));
  assert.ok(counts, "the tab counts were never asked");
  assert.deepEqual(counts.params, {}, "status, paging or scope leaked into the counts filters");
  assert.equal(counts.headers["X-Didit-Organization-Id"], "org-1");
  assert.equal(counts.headers["X-Didit-Application-Id"], "app-1");
});

test("a tab count at its own cap is still marked as a lower bound", async () => {
  backend({ count: 100, counts: { views: { needs_review: 10000 } } });

  const result = await run({ status: "In Review" });

  assert.equal(result.total_count, 10000);
  assert.equal(result.count_is_lower_bound, true);
  assert.match(result.count_note, /at least that many/);
});

test("an unfiltered capped count reads the All tab and keeps the other filters", async () => {
  const calls = backend({ count: 100, counts: { views: { all: 1884 } } });

  const result = await run({ workflow_id: "wf-1", limit: "1" });

  assert.equal(result.total_count, 1884);
  assert.deepEqual(calls.at(-1).params, { workflow_id: "wf-1" });
});

test("a status the tab counts cannot express alone stays an honest lower bound", async () => {
  const calls = backend({ count: 100, counts: { views: { all: 1884 } } });

  const result = await run({ status: "Not Started,In Progress" });

  assert.equal(result.count_is_lower_bound, true);
  assert.match(result.count_note, /at least 100/);
  assert.equal(result.total_count, undefined);
  assert.equal(calls.length, 1, "the counts were asked for a status they cannot answer");
});

test("a busy counts endpoint never fails the list", async () => {
  backend({ count: 100, countsStatus: 429 });

  const result = await run({ status: "Approved" });

  assert.equal(result.count_is_lower_bound, true);
  assert.deepEqual(result.results, [{ session_id: "s-1" }]);
});

test("an uncapped count is exact and costs no second request", async () => {
  const calls = backend({ count: 37 });

  const result = await run({ status: "In Review" });

  assert.equal(result.count, 37);
  assert.equal(result.total_count, undefined);
  assert.equal(calls.length, 1);
});
