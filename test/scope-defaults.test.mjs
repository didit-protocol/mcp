import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// an app-scoped tool must resolve the caller's UNAMBIGUOUS application on its
// own. didit_context_get advertises `default_application_id` whenever the caller owns
// exactly ONE application across ALL their organizations, but ensureScopeDefaults only
// resolved it when the caller also owned exactly ONE organization. A user with a second
// (app-less) organization therefore got "application_id is required for this operation"
// from didit_lists_list / didit_webhook_list while didit_context_get insisted a default
// application existed. That was the top tool-failure class in the assistant's production
// traces (25x didit_lists_list, 9x didit_webhook_list in one afternoon).

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Route fetches by exact URL path (query stripped); anything unrouted 404s like the backend. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = routes[String(url).split("?")[0]];
    if (body === undefined) return json({ detail: "Not found." }, 404);
    return json(body);
  };
  return calls;
}

/** Call one tool through the real MCP dispatcher (ensureScopeDefaults included). */
async function callTool(name, args = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "scope-defaults-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (res) => res.content.map((c) => c.text).join("\n");

/** getOrgAppMap caches per access token — every test needs its own. */
function withToken(token) {
  process.env.DIDIT_ACCESS_TOKEN = token;
  delete process.env.MCP_DEFAULT_ORG;
  delete process.env.MCP_DEFAULT_APP;
}

// Two organizations, only one of which holds an application: exactly the shape that
// makes didit_context_get report a default_application_id.
const TWO_ORGS_ONE_APP = {
  [`${AUTH}/organizations/me/`]: [
    { uuid: "org-empty", name: "Personal" },
    { uuid: "org-1", name: "Acme" },
  ],
  [`${AUTH}/organizations/me/org-empty/applications/`]: [],
  [`${AUTH}/organizations/me/org-1/applications/`]: [{ uuid: "app-1", name: "Acme Prod", mode: "live" }],
};

test("didit_context_get reports a default application when only one org holds one", async () => {
  withToken("tok-ctx");
  stubFetch(TWO_ORGS_ONE_APP);

  const payload = JSON.parse(textOf(await callTool("didit_context_get")));

  assert.equal(payload.application_count, 1);
  assert.equal(payload.default_application_id, "app-1");
});

test("didit_lists_list resolves the single application across several orgs", async () => {
  withToken("tok-lists");
  const calls = stubFetch({
    ...TWO_ORGS_ONE_APP,
    [`${API}/organization/org-1/application/app-1/lists/`]: { count: 1, results: [{ uuid: "list-1" }] },
  });

  const res = await callTool("didit_lists_list", {});

  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(JSON.parse(textOf(res)).count, 1);
  assert.ok(
    calls.some((u) => u.startsWith(`${API}/organization/org-1/application/app-1/lists/`)),
    `expected the app-scoped lists call, got:\n${calls.join("\n")}`,
  );
});

test("didit_webhook_list resolves the single application across several orgs", async () => {
  withToken("tok-webhooks");
  stubFetch({
    ...TWO_ORGS_ONE_APP,
    [`${API}/organization/org-1/application/app-1/webhook/destinations/`]: {
      count: 1,
      results: [{ uuid: "dest-1", url: "https://acme.example/hook", secret: "shh" }],
    },
  });

  const res = await callTool("didit_webhook_list", {});

  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(JSON.parse(textOf(res)).count, 1);
});

test("a genuinely ambiguous caller still gets the actionable error, not a guess", async () => {
  withToken("tok-ambiguous");
  stubFetch({
    [`${AUTH}/organizations/me/`]: [{ uuid: "org-1", name: "Acme" }],
    [`${AUTH}/organizations/me/org-1/applications/`]: [
      { uuid: "app-1", name: "Prod" },
      { uuid: "app-2", name: "Staging" },
    ],
  });

  const res = await callTool("didit_webhook_list", {});

  assert.equal(res.isError, true);
  assert.match(textOf(res), /application_id is required/);
  assert.match(textOf(res), /didit_context_get/);
});

test("an explicit application_id still wins over the resolved default", async () => {
  withToken("tok-explicit");
  const calls = stubFetch({
    ...TWO_ORGS_ONE_APP,
    [`${API}/organization/org-2/application/app-9/lists/`]: { count: 0, results: [] },
  });

  const res = await callTool("didit_lists_list", { organization_id: "org-2", application_id: "app-9" });

  assert.equal(res.isError, undefined, textOf(res));
  assert.ok(calls.some((u) => u.startsWith(`${API}/organization/org-2/application/app-9/lists/`)));
});

test("routing ids never leak into the query string of the call they routed", async () => {
  withToken("tok-noleak");
  const calls = stubFetch({
    ...TWO_ORGS_ONE_APP,
    [`${API}/organization/org-1/application/app-1/lists/`]: { count: 0, results: [] },
  });

  await callTool("didit_lists_list", { organization_id: "org-1", application_id: "app-1", list_type: "blocklist" });

  const listCall = new URL(calls.find((u) => u.includes("/lists/")));
  assert.equal(listCall.searchParams.get("list_type"), "blocklist");
  assert.equal(listCall.searchParams.get("organization_id"), null);
  assert.equal(listCall.searchParams.get("application_id"), null);
});

// The same strip that made declaring the routing ids safe also starved the handlers that
// take them as EXPLICIT PARAMETERS instead of reading requestContext: the auth-service
// discovery/reveal tools build their URL path from the argument, and the *_search tools use
// it to narrow the fan-out. Both silently received `undefined`.

const TWO_ORGS_TWO_APPS = {
  [`${AUTH}/organizations/me/`]: [
    { uuid: "org-1", name: "Acme" },
    { uuid: "org-2", name: "Globex" },
  ],
  [`${AUTH}/organizations/me/org-1/applications/`]: [{ uuid: "app-1", name: "Acme Prod" }],
  [`${AUTH}/organizations/me/org-2/applications/`]: [{ uuid: "app-2", name: "Globex Prod" }],
};

test("didit_org_list_applications uses the organization_id it was given", async () => {
  withToken("tok-orgapps");
  stubFetch(TWO_ORGS_TWO_APPS);

  const res = await callTool("didit_org_list_applications", { organization_id: "org-2" });

  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(
    JSON.parse(textOf(res)).map((a) => a.uuid),
    ["app-2"],
  );
});

test("didit_org_get_application uses both ids it was given", async () => {
  withToken("tok-orgapp-get");
  stubFetch({
    ...TWO_ORGS_TWO_APPS,
    [`${AUTH}/organizations/me/org-2/applications/app-2/`]: { uuid: "app-2", name: "Globex Prod" },
  });

  const res = await callTool("didit_org_get_application", { organization_id: "org-2", application_id: "app-2" });

  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(JSON.parse(textOf(res)).uuid, "app-2");
});

test("didit_org_reveal_application_api_key still reaches its explicit-ids guard", async () => {
  withToken("tok-reveal");
  stubFetch({
    ...TWO_ORGS_TWO_APPS,
    [`${AUTH}/organizations/me/org-2/applications/app-2/`]: { uuid: "app-2", api_key: "live_secret" },
  });

  const res = await callTool("didit_org_reveal_application_api_key", {
    organization_id: "org-2",
    application_id: "app-2",
    confirm: true,
  });

  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(JSON.parse(textOf(res)).api_key, "live_secret");
});

test("didit_session_search narrows to the organization it was given", async () => {
  withToken("tok-search");
  const calls = stubFetch({
    ...TWO_ORGS_TWO_APPS,
    [`${API}/organization/org-1/sessions/`]: { results: [{ session_id: "s-1", created_at: "2026-08-01T00:00:00Z" }] },
    [`${API}/organization/org-2/sessions/`]: { results: [{ session_id: "s-2", created_at: "2026-08-02T00:00:00Z" }] },
  });

  const res = await callTool("didit_session_search", { organization_id: "org-1" });

  assert.equal(res.isError, undefined, textOf(res));
  assert.deepEqual(
    JSON.parse(textOf(res)).results.map((r) => r.session_id),
    ["s-1"],
  );
  assert.ok(
    !calls.some((u) => u.includes("/organization/org-2/")),
    `search must not reach into an org it was not scoped to:\n${calls.join("\n")}`,
  );
});

// Production, 11 and 12 November 2026 (the first day the tool-call lines reached the log store):
// every failure with the generic code but one was this error, from people with several
// applications whose call named none (didit_webhook_list 18 of 100 calls). The error told the model
// to call didit_context_get and retry: two more round trips. It now names the applications, so the
// retry is the next call, and it has a code of its own so the log can tell it from a real fault.

const UUID = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

test("an ambiguous call is told which applications it could mean, with their ids", async () => {
  withToken("tok-choices");
  const calls = stubFetch({
    [`${AUTH}/organizations/me/`]: [{ uuid: UUID(1), name: "Acme" }],
    [`${AUTH}/organizations/me/${UUID(1)}/applications/`]: [
      { uuid: UUID(11), name: "Acme Trading", mode: "live" },
      { uuid: UUID(12), name: "Acme Trading (sandbox)", mode: "sandbox" },
      { uuid: UUID(13), name: "Acme Pay" },
    ],
  });

  const res = await callTool("didit_webhook_list", {});
  const text = textOf(res);

  assert.equal(res.isError, true);
  // The opening is the sentence clients already recognise (the console assistant quotes it).
  assert.match(text, /^Error \[application_required\]: application_id is required for this operation/);
  assert.match(text, /3 applications/);
  for (const [id, name] of [[UUID(11), "Acme Trading"], [UUID(12), "Acme Trading (sandbox)"], [UUID(13), "Acme Pay"]]) {
    assert.ok(text.includes(`application_id ${id}`), `names the id of ${name}`);
    assert.ok(text.includes(name), `names ${name}`);
  }
  assert.ok(text.includes(`organization_id ${UUID(1)}`));
  // Live and sandbox are told apart: one bills, the other does not.
  assert.match(text, /Acme Trading \(live\)/);
  assert.match(text, /Acme Trading \(sandbox\) \(sandbox\)/);
  assert.match(text, /\nField: application_id/);
  // Nothing was asked of the backend for a call that could not be placed.
  assert.ok(!calls.some((url) => url.includes("/webhook/")), calls.join("\n"));

  // The retry the error asks for works as it is.
  stubFetch({ [`${API}/organization/${UUID(1)}/application/${UUID(12)}/webhook/destinations/`]: { count: 0, results: [] } });
  const retry = await callTool("didit_webhook_list", { organization_id: UUID(1), application_id: UUID(12) });
  assert.equal(retry.isError, undefined, textOf(retry));
});

test("applications in several organizations are listed with the organization they belong to", async () => {
  withToken("tok-choices-orgs");
  stubFetch({
    [`${AUTH}/organizations/me/`]: [{ uuid: UUID(1), name: "Acme" }, { uuid: UUID(2), name: "Globex" }],
    [`${AUTH}/organizations/me/${UUID(1)}/applications/`]: [{ uuid: UUID(11), name: "Main", mode: "live" }],
    [`${AUTH}/organizations/me/${UUID(2)}/applications/`]: [{ uuid: UUID(21), name: "Main", mode: "live" }],
  });

  const text = textOf(await callTool("didit_branding_get", {}));

  // No organization is pinned, so the first id the path needs is the organization's.
  assert.match(text, /^Error \[organization_required\]: organization_id is required for this operation/);
  assert.ok(text.includes(`application_id ${UUID(11)}, organization_id ${UUID(1)} (Acme)`), text);
  assert.ok(text.includes(`application_id ${UUID(21)}, organization_id ${UUID(2)} (Globex)`), text);
});

test("a long list of applications is cut, and says where the rest is", async () => {
  withToken("tok-choices-many");
  stubFetch({
    [`${AUTH}/organizations/me/`]: [{ uuid: UUID(1), name: "Acme" }],
    [`${AUTH}/organizations/me/${UUID(1)}/applications/`]: Array.from({ length: 30 }, (_, i) => ({ uuid: UUID(100 + i), name: `App ${i + 1}` })),
  });

  const text = textOf(await callTool("didit_webhook_list", {}));

  assert.match(text, /30 applications/);
  assert.ok(text.includes(UUID(100)) && text.includes(UUID(111)), "the first twelve are listed");
  assert.ok(!text.includes(UUID(112)), "the thirteenth is not");
  assert.match(text, /18 more: call didit_context_get/);
});

test("when the applications cannot be read, the error still says how to find them", async () => {
  withToken("tok-choices-blind");
  stubFetch({});

  const text = textOf(await callTool("didit_webhook_list", {}));

  assert.match(text, /^Error \[organization_required\]: organization_id is required for this operation/);
  assert.match(text, /didit_context_get/);
});

test("an organization whose applications could not be listed makes the choices incomplete, and the error says so", async () => {
  withToken("tok-choices-partial");
  globalThis.fetch = async (url) => {
    const path = String(url).split("?")[0];
    if (path === `${AUTH}/organizations/me/`) return json([{ uuid: UUID(1), name: "Acme" }, { uuid: UUID(2), name: "Globex" }]);
    if (path === `${AUTH}/organizations/me/${UUID(1)}/applications/`) return json([{ uuid: UUID(11), name: "Main" }]);
    return json({ detail: "Forbidden." }, 403);
  };

  const text = textOf(await callTool("didit_webhook_list", {}));

  // One application is known, but it is not safe to assume it is the only one.
  assert.match(text, /required for this operation/);
  assert.ok(text.includes(UUID(11)));
  assert.match(text, /could not be listed/);
});
