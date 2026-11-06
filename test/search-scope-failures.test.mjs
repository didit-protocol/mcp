import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The cross-org/app aggregate search fans out over every (org, app) the caller can reach and
// is deliberately resilient: an application whose role cannot read the resource (403) or that
// does not expose it (404) is reported as a skipped scope, not as a failed search.
//
// What it must NEVER do is turn a real failure into an empty success. Before this contract,
// every branch error was swallowed: a revoked or expired token (401), a filter the backend
// rejected (400/422), rate limiting, a backend 5xx and a network failure all came back as
// `{results: [], returned: 0, aggregated: true}`, which an assistant reads to the user as
// "you have no sessions / transactions / cases / workflows". A caller whose role is refused
// on every reachable application got the same empty success instead of a permission error.

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.MCP_DEFAULT_ORG;
delete process.env.MCP_DEFAULT_APP;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ORGS = [
  { uuid: "org-1", name: "Acme" },
  { uuid: "org-2", name: "Beta" },
];

/**
 * Route by pathname and HTTP status: `<path>` answers `status` and an optional row payload.
 * Org-level and per-app list calls are told apart by the `/application/` segment.
 */
function stubFetch({ orgLevel, perApp }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    calls.push(path);

    const org = /^\/auth\/v2\/organizations\/me\/([^/]+)\/applications\/$/.exec(path);
    if (org) return json([{ uuid: `app-${org[1]}`, name: `App ${org[1]}`, mode: "sandbox" }]);
    if (path === "/auth/v2/organizations/me/") return json(ORGS);

    if (/^\/v3\/organization\/[^/]+\/application\/[^/]+\//.test(path)) {
      const answer = perApp(path);
      return answer.rows ? json({ count: answer.rows.length, results: answer.rows }) : json({ detail: "Error" }, answer.status);
    }
    if (/^\/v3\/organization\/[^/]+\//.test(path)) {
      const answer = orgLevel(path);
      return answer.rows ? json({ count: answer.rows.length, results: answer.rows }) : json({ detail: "Error" }, answer.status);
    }
    return json({ detail: "Not found." }, 404);
  };
  return calls;
}

async function callTool(name, args, token) {
  process.env.DIDIT_ACCESS_TOKEN = token; // fresh token per test: the org/app map is cached per token
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "search-scope-failures-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (res) => res.content.map((c) => c.text).join("\n");
const SESSION_ROW = { session_id: "33333333-3333-4333-8333-333333333333", status: "Approved", created_at: "2026-10-29T10:00:00Z" };

for (const [label, status, code] of [
  ["a revoked/expired token (401)", 401, "unauthorized"],
  ["a filter the backend rejects (400)", 400, "bad_request"],
  ["rate limiting (429)", 429, "rate_limited"],
  ["a backend failure (500)", 500, "server_error"],
]) {
  test(`didit_session_search surfaces ${label} instead of an empty success`, async () => {
    stubFetch({ orgLevel: () => ({ status }), perApp: () => ({ status }) });

    const res = await callTool("didit_session_search", { limit: 5 }, `tok-session-${status}`);

    assert.equal(res.isError, true, textOf(res));
    assert.match(textOf(res), new RegExp(`^Error \\[${code}\\]`));
    assert.doesNotMatch(textOf(res), /"results":\[\]/);
  });
}

test("didit_session_search falls back to per-app listing when the org endpoint is absent (404)", async () => {
  stubFetch({
    orgLevel: () => ({ status: 404 }),
    perApp: (path) => ({ rows: path.includes("/application/app-org-1/") ? [SESSION_ROW] : [] }),
  });

  const res = await callTool("didit_session_search", { limit: 5 }, "tok-session-fallback");

  assert.equal(res.isError, undefined, textOf(res));
  const body = JSON.parse(textOf(res));
  assert.equal(body.results.length, 1);
  assert.match(String(body.via), /per-app fallback/);
});

test("didit_session_search keeps a partial fan-out when only some applications are refused", async () => {
  stubFetch({
    orgLevel: () => ({ status: 403 }),
    perApp: (path) =>
      path.includes("/application/app-org-1/") ? { rows: [SESSION_ROW] } : { status: 403 },
  });

  const res = await callTool("didit_session_search", { limit: 5 }, "tok-session-partial");

  assert.equal(res.isError, undefined, textOf(res));
  const body = JSON.parse(textOf(res));
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].application_id, "app-org-1");
});

test("didit_session_search says permission denied when every reachable application is refused", async () => {
  stubFetch({ orgLevel: () => ({ status: 403 }), perApp: () => ({ status: 403 }) });

  const res = await callTool("didit_session_search", { limit: 5 }, "tok-session-denied");

  assert.equal(res.isError, true, textOf(res));
  assert.match(textOf(res), /^Error \[forbidden\]/);
  assert.match(textOf(res), /cannot read this resource in any of the 2 application/);
});

test("didit_vendor_user_search surfaces a backend failure instead of an empty directory", async () => {
  stubFetch({ orgLevel: () => ({ status: 404 }), perApp: () => ({ status: 500 }) });

  const res = await callTool("didit_vendor_user_search", { limit: 5 }, "tok-vendor-500");

  assert.equal(res.isError, true, textOf(res));
  assert.match(textOf(res), /^Error \[server_error\]/);
});

test("didit_workflow_search surfaces a revoked token instead of 'no workflows'", async () => {
  stubFetch({ orgLevel: () => ({ status: 404 }), perApp: () => ({ status: 401 }) });

  const res = await callTool("didit_workflow_search", { limit: 5 }, "tok-workflow-401");

  assert.equal(res.isError, true, textOf(res));
  assert.match(textOf(res), /^Error \[unauthorized\]/);
});
