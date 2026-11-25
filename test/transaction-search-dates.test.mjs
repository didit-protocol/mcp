import { test } from "node:test";
import assert from "node:assert/strict";
import { searchTransactions } from "../dist/tools/search.js";

// The transaction lists read `start_date` / `end_date` (days only) and ignore any other parameter,
// so a search that sent date_from / date_to answered with every transaction, newest first.

process.env.DIDIT_ACCESS_TOKEN = "dates-token";

function recordQueries(t) {
  const queries = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    queries.push(Object.fromEntries(new URL(String(url)).searchParams));

    return Response.json({ count: 0, results: [] });
  });

  return queries;
}

const SCOPE = { organization_id: "org-1", application_id: "app-1" };

test("the search's dates travel under the names and in the form the transaction lists read", async (t) => {
  const queries = recordQueries(t);
  await searchTransactions({ ...SCOPE, date_from: "2026-11-01T00:00:00Z", date_to: "2026-11-20" });
  assert.equal(queries.at(-1).start_date, "2026-11-01");
  assert.equal(queries.at(-1).end_date, "2026-11-20");
  assert.ok(!("date_from" in queries.at(-1)) && !("date_to" in queries.at(-1)));
});

test("last_n_days becomes the same window", async (t) => {
  const queries = recordQueries(t);
  await searchTransactions({ ...SCOPE, last_n_days: 7 });
  assert.match(queries.at(-1).start_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(queries.at(-1).end_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!("last_n_days" in queries.at(-1)));
});

test("the list's own start_date and end_date survive when it spans the applications", async (t) => {
  const queries = recordQueries(t);
  await searchTransactions({ ...SCOPE, start_date: "2026-11-01", end_date: "2026-11-20" });
  assert.deepEqual([queries.at(-1).start_date, queries.at(-1).end_date], ["2026-11-01", "2026-11-20"]);
});
