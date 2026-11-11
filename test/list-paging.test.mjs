import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requestContext } from "../dist/config.js";
import { createServer } from "../dist/index.js";
import { MAX_PAGE_SIZE, everyPage, pageParams, wholeEnvelope } from "../dist/paging.js";
import { resolveWorkflowScope } from "../dist/tools/search.js";

// The API serves most lists a page at a time: 20 workflows, 50 of most other things. A tool that
// sent no paging argument returned the first page and nothing said so. Seen on staging: the
// Demo application has 76 workflows, the tool listed 20, and asked "how many workflows are
// drafts" an assistant answered "I could only read 20 of the 76". The search across
// applications read the same first page of each, so a workflow outside the 20 most recently
// changed could not be found by its name.
//
// Now a list a model reads takes `limit` and `offset` and says `count`, and the lists the server
// itself depends on (workflows by id or label, the caller's organizations and applications)
// are read whole.

for (const name of ["DIDIT_ACCESS_TOKEN", "DIDIT_IS_STAFF", "MCP_DEFAULT_TOOLSETS", "MCP_PERMISSION_MODE"]) delete process.env[name];

const API = "https://verification.didit.me/v3";
const APP_BASE = `${API}/organization/org-1/application/app-1`;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The page of `rows` a request asks for, in the envelope the API uses. */
function page(rows, url, defaultSize) {
  const query = new URL(url).searchParams;
  const limit = Number(query.get("limit") ?? defaultSize);
  const offset = Number(query.get("offset") ?? 0);

  return { count: rows.length, next: offset + limit < rows.length ? "https://next.page/" : null, previous: null, results: rows.slice(offset, offset + limit) };
}

/** Answer every request from `routes` (first matching path wins) and record what was asked. */
function backend(routes) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    seen.push({ url: target, path: new URL(target).pathname, query: Object.fromEntries(new URL(target).searchParams), method: init.method ?? "GET" });
    for (const [match, answer] of routes) if (new URL(target).pathname.endsWith(match)) return answer(target);

    return json({ detail: "Not found." }, 404);
  };

  return { seen, restore: () => (globalThis.fetch = original) };
}

let tokens = 0;
/** A signed-in person; a new token each time, because the organization map is cached per token. */
const person = () => ({ token: `person.token.${++tokens}`, clientId: "list-paging-test", scopes: [], extra: { organization_id: "org-1" } });

async function withClient(authInfo, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  const client = new Client({ name: "list-paging-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const SCOPE = { organization_id: "org-1", application_id: "app-1" };
const textOf = (result) => result.content.map((item) => item.text).join("\n");
const workflows = (count) =>
  Array.from({ length: count }, (_, index) => ({ uuid: `version-${index}`, workflow_id: `stable-${index}`, workflow_label: `Workflow ${index}`, status: index % 2 ? "draft" : "published" }));

test("a paged list tool takes limit and offset and tells the model how to read the rest", async () => {
  await withClient(person(), async (client) => {
    const byName = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    for (const name of ["didit_workflow_list", "didit_questionnaire_list", "didit_session_list_reviews", "didit_report_list", "didit_investigator_question_list"]) {
      const tool = byName.get(name);
      if (!tool) continue; // not every build has every tool
      const { limit, offset } = tool.inputSchema.properties;
      assert.equal(limit?.type, "number", `${name} takes limit`);
      assert.equal(offset?.type, "number", `${name} takes offset`);
      assert.ok(limit.description.length > 0 && offset.description.length > 0, `${name} says what they are`);
      assert.match(tool.description, /`count`/, `${name} says the answer carries the total`);
      assert.ok(!(tool.inputSchema.required ?? []).includes("limit"), `${name}: paging is optional`);
    }
    assert.match(byName.get("didit_workflow_list").description, /20 workflows unless `limit` says otherwise/);
  });
});

test("the workflow list sends the page that was asked for, and the API's default when none was", async () => {
  const all = workflows(76);
  const api = backend([["/verification-settings/", (url) => json(page(all, url, 20))]]);
  try {
    await withClient(person(), async (client) => {
      const call = (args) => client.callTool({ name: "didit_workflow_list", arguments: { ...SCOPE, ...args } });

      const first = (await call({})).structuredContent;
      assert.deepEqual(api.seen.at(-1).query, {}, "no paging argument: the API decides the page");
      assert.equal(first.count, 76, "the answer says how many there are");
      assert.equal(first.results.length, 20);

      const rest = (await call({ limit: 100, offset: 20 })).structuredContent;
      assert.deepEqual(api.seen.at(-1).query, { limit: "100", offset: "20" });
      assert.equal(rest.results.length, 56);
      assert.equal(rest.results[0].uuid, "version-20");

      // A model sometimes sends a number as text.
      await call({ limit: "50" });
      assert.deepEqual(api.seen.at(-1).query, { limit: "50" });

      const before = api.seen.length;
      for (const bad of [{ limit: 0 }, { limit: MAX_PAGE_SIZE + 1 }, { limit: 1.5 }, { limit: "many" }, { limit: true }, { offset: -1 }, { offset: "x" }]) {
        const refused = await call(bad);
        assert.equal(refused.isError, true, `accepted ${JSON.stringify(bad)}`);
        assert.match(textOf(refused), /Error \[bad_request\]/);
        assert.match(textOf(refused), /must be a whole number/);
      }
      assert.equal(api.seen.length, before, "a bad page is refused before anything is sent");
    });
  } finally {
    api.restore();
  }
});

test("questionnaires, session reviews and reports send their page and their filters", async () => {
  const api = backend([
    ["/questionnaires/", (url) => json(page([], url, 50))],
    ["/reviews/", (url) => json(page([], url, 50))],
    ["/reports/", (url) => json({ ...page([], url, 50), counts: {} })],
  ]);
  try {
    await withClient(person(), async (client) => {
      const call = (name, args) => client.callTool({ name, arguments: { ...SCOPE, ...args } });

      await call("didit_questionnaire_list", { limit: 10, offset: 50 });
      assert.equal(api.seen.at(-1).url, `${APP_BASE}/questionnaires/?limit=10&offset=50`);
      await call("didit_questionnaire_list", {});
      assert.equal(api.seen.at(-1).url, `${APP_BASE}/questionnaires/`);

      await call("didit_session_list_reviews", { session_id: "11111111-1111-4111-8111-111111111111", limit: 5 });
      assert.equal(api.seen.at(-1).url, `${APP_BASE}/sessions/11111111-1111-4111-8111-111111111111/reviews/?limit=5`);

      await call("didit_report_list", { status: "READY,FAILED", report_type: "SESSION_EXPORT", q: "maria", limit: 5, offset: 5 });
      assert.deepEqual(api.seen.at(-1).query, { status: "READY,FAILED", report_type: "SESSION_EXPORT", q: "maria", limit: "5", offset: "5" });
      const refused = await call("didit_report_list", { limit: 1000 });
      assert.equal(refused.isError, true);
    });
  } finally {
    api.restore();
  }
});

test("the search across applications reads every page, so a workflow past the first one is found", async () => {
  const all = workflows(450);
  const api = backend([
    ["/organizations/me/", (url) => json(page([{ uuid: "org-1", name: "Acme" }], url, 50))],
    ["/organizations/me/org-1/applications/", (url) => json(page([{ uuid: "app-1", name: "Acme", mode: "live" }], url, 50))],
    ["/verification-settings/", (url) => json(page(all, url, 20))],
  ]);
  try {
    await withClient(person(), async (client) => {
      const found = (await client.callTool({ name: "didit_workflow_search", arguments: { search: "Workflow 431" } })).structuredContent;
      assert.equal(found.total_matched, 1);
      assert.equal(found.results[0].workflow_id, "stable-431");
      assert.equal(found.results[0].application_id, "app-1");
      assert.equal(found.partly_read_apps, undefined);
      const lists = api.seen.filter((request) => request.path.endsWith("/verification-settings/"));
      assert.deepEqual(lists.map((request) => request.query), [
        { limit: "200", offset: "0" },
        { limit: "200", offset: "200" },
        { limit: "200", offset: "400" },
      ]);

      const everything = (await client.callTool({ name: "didit_workflow_search", arguments: { limit: 200 } })).structuredContent;
      assert.equal(everything.total_matched, 450, "the total counts every workflow, not the first page of each application");
      assert.equal(everything.returned, 200);
    });

    // The graph tools resolve a stable workflow id inside a known application the same way.
    const scope = await requestContext.run({ accessToken: "person.token.resolve", organizationId: "org-1", applicationId: "app-1" }, () =>
      resolveWorkflowScope("stable-431", "org-1", "app-1"),
    );
    assert.equal(scope.workflow.uuid, "version-431");
  } finally {
    api.restore();
  }
});

test("across applications the workflow list pages too: the second page is not the first one again", async () => {
  const perApplication = { "app-1": workflows(60).map((row) => ({ ...row, uuid: `a-${row.uuid}` })), "app-2": workflows(60).map((row) => ({ ...row, uuid: `b-${row.uuid}` })) };
  const api = backend([
    ["/organizations/me/", (url) => json(page([{ uuid: "org-1", name: "Acme" }], url, 50))],
    ["/organizations/me/org-1/applications/", (url) => json(page([{ uuid: "app-1", name: "Live" }, { uuid: "app-2", name: "Sandbox" }], url, 50))],
    ["/application/app-1/verification-settings/", (url) => json(page(perApplication["app-1"], url, 20))],
    ["/application/app-2/verification-settings/", (url) => json(page(perApplication["app-2"], url, 20))],
  ]);
  try {
    await withClient(person(), async (client) => {
      // Two applications and none named: the list answers for both.
      const read = async (args) => (await client.callTool({ name: "didit_workflow_list", arguments: args })).structuredContent;
      const first = await read({ limit: 50 });
      assert.equal(first.aggregated, true);
      assert.equal(first.total_matched, 120);
      assert.equal(first.returned, 50);
      const second = await read({ limit: 50, offset: 50 });
      const third = await read({ limit: 50, offset: 100 });
      assert.equal(second.offset, 50);
      assert.deepEqual([second.returned, third.returned], [50, 20]);
      const seen = [...first.results, ...second.results, ...third.results].map((row) => row.uuid);
      assert.equal(new Set(seen).size, 120, "three pages, every workflow once");
      assert.deepEqual((await read({ offset: 500 })).results, []);
      const refused = await client.callTool({ name: "didit_workflow_list", arguments: { offset: -1 } });
      assert.equal(refused.isError, true);
    });
  } finally {
    api.restore();
  }
});

test("a list that never ends stops being read, and the answer says it is partial", async () => {
  const endless = (url) => {
    const offset = Number(new URL(url).searchParams.get("offset") ?? 0);

    return json({ count: 1_000_000, next: "https://next.page/", previous: null, results: workflows(MAX_PAGE_SIZE).map((row) => ({ ...row, uuid: `${row.uuid}-${offset}` })) });
  };
  const api = backend([
    ["/organizations/me/", (url) => json(page([{ uuid: "org-1", name: "Acme" }], url, 50))],
    ["/organizations/me/org-1/applications/", (url) => json(page([{ uuid: "app-1", name: "Acme" }], url, 50))],
    ["/verification-settings/", endless],
  ]);
  try {
    await withClient(person(), async (client) => {
      const found = (await client.callTool({ name: "didit_workflow_search", arguments: { search: "no such label" } })).structuredContent;
      assert.equal(found.partly_read_apps, 1);
      const pages = api.seen.filter((request) => request.path.endsWith("/verification-settings/")).length;
      assert.equal(pages, 25, "the read stops at its cap");
    });
  } finally {
    api.restore();
  }
});

test("the organizations and applications a caller can reach are read whole", async () => {
  const apps = Array.from({ length: 230 }, (_, index) => ({ uuid: `app-${index}`, name: `Application ${index}`, mode: index % 2 ? "sandbox" : "live" }));
  const api = backend([
    ["/organizations/me/", (url) => json(page([{ uuid: "org-1", name: "Acme" }], url, 50))],
    ["/organizations/me/org-1/applications/", (url) => json(page(apps, url, 50))],
  ]);
  try {
    await withClient(person(), async (client) => {
      const context = (await client.callTool({ name: "didit_context_get", arguments: {} })).structuredContent;
      assert.equal(context.application_count, 230, "an application on a later page exists for the caller");
      assert.ok(context.organizations[0].applications.some((app) => app.application_id === "app-229"));

      const listed = (await client.callTool({ name: "didit_org_list_applications", arguments: { organization_id: "org-1" } })).structuredContent;
      assert.equal(listed.count, 230);
      assert.equal(listed.results.length, 230);
      assert.equal(listed.next, null, "nothing is left to page through");
      const requests = api.seen.filter((request) => request.path.endsWith("/applications/")).slice(-2);
      assert.deepEqual(requests.map((request) => request.query), [{ limit: "200", offset: "0" }, { limit: "200", offset: "200" }]);
    });
  } finally {
    api.restore();
  }
});

test("reading every page: stops at the last page, keeps a bare list bare, and says when it gave up", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: index }));
  const asked = [];
  const paged = await everyPage(async ({ limit, offset }) => {
    asked.push({ limit, offset });

    return { count: 5, next: null, results: rows.slice(offset, offset + limit) };
  });
  assert.deepEqual([paged.rows.length, paged.total, paged.complete], [5, 5, true]);
  assert.deepEqual(asked, [{ limit: MAX_PAGE_SIZE, offset: 0 }]);

  // An endpoint that does not page answers a bare array: that is the whole list, in one request.
  const bare = await wholeEnvelope(async () => rows);
  assert.deepEqual(bare, rows);

  // The envelope the API uses, with nothing left to page through.
  const whole = await wholeEnvelope(async ({ offset }) => ({ count: 5, next: offset === 0 ? "more" : null, results: rows.slice(offset, offset + 3) }));
  assert.deepEqual(whole, { count: 5, next: null, previous: null, results: rows });

  // Some endpoints stop counting at 100: `count` is then a floor, and the list ends where `next` does.
  const many = Array.from({ length: 450 }, (_, index) => ({ id: index }));
  const capped = await everyPage(async ({ limit, offset }) => ({
    count: 100,
    next: offset + limit < many.length ? "more" : null,
    results: many.slice(offset, offset + limit),
  }));
  assert.deepEqual([capped.rows.length, capped.total, capped.complete], [450, 450, true]);
  assert.deepEqual(capped.rows.at(-1), { id: 449 });

  // A page with nothing in it ends the read even if the API still claims there is more.
  const stalled = await everyPage(async () => ({ count: 99, next: "more", results: [] }));
  assert.deepEqual([stalled.rows.length, stalled.complete], [0, true]);

  assert.deepEqual(pageParams({ limit: 50, offset: 0 }), { limit: 50, offset: 0 });
  assert.deepEqual(pageParams({ limit: "", offset: null }), {});
  assert.deepEqual(pageParams(undefined), {});
  assert.throws(() => pageParams({ limit: -5 }), /whole number from 1 to 200/);
});
