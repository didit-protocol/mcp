import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// `application_ids` narrows the cross-application reads to SEVERAL applications. A client whose
// conversation may read only part of an organization (the applications of one data location)
// cannot use `application_id`, which takes one, nor filter the answer afterwards: the analytics
// are sums. So no application outside the list is asked, and the organization-wide endpoint, which
// answers for all of them, is not either.

const ORG = "org-1";
const APPS = ["app-a", "app-b", "app-c"];
const TOOLS = [
  "didit_session_search",
  "didit_transaction_search",
  "didit_case_search",
  "didit_vendor_user_search",
  "didit_vendor_business_search",
  "didit_workflow_search",
  "didit_analytics",
];

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.MCP_DEFAULT_ORG;
delete process.env.MCP_DEFAULT_APP;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Answers every read with nothing found, and records which scopes were asked. */
function stubFetch() {
  const read = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const scope = /^\/v3\/organization\/([^/]+)\/(?:application\/([^/]+)\/)?/.exec(path);

    if (path === "/auth/v2/organizations/me/") return json([{ uuid: ORG, name: "Acme" }]);
    if (/\/applications\/$/.test(path)) return json(APPS.map((uuid) => ({ uuid, name: uuid, mode: "live" })));
    if (!scope) return json({ detail: "Not found." }, 404);
    read.push(scope[2] ?? "organization");

    return path.endsWith("/analytics/") ? json({ request_breakdown: { total_approved: 1 } }) : json({ count: 0, results: [] });
  };

  return read;
}

async function withClient(token, run) {
  process.env.DIDIT_ACCESS_TOKEN = token; // fresh per call: the org/app map is cached per token
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "application-ids-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const scopesRead = async (name, args, token) => {
  const read = stubFetch();
  const result = await withClient(token, (client) => client.callTool({ name, arguments: args }));

  assert.ok(!result.isError, JSON.stringify(result.content));

  return { read: [...new Set(read)].sort(), result };
};

test("every cross-application read declares application_ids", async () => {
  stubFetch();
  const { tools } = await withClient("tok-list", (client) => client.listTools());
  const declaring = tools.filter((tool) => "application_ids" in tool.inputSchema.properties).map((tool) => tool.name);

  assert.deepEqual(declaring.sort(), [...TOOLS].sort());
});

for (const name of TOOLS) {
  test(`${name} reads the applications it is given and no other, with and without the organization`, async () => {
    const ids = { application_ids: ["app-a", "APP-C"] };

    assert.deepEqual((await scopesRead(name, ids, `tok-${name}-1`)).read, ["app-a", "app-c"]);
    assert.deepEqual((await scopesRead(name, { ...ids, organization_id: ORG }, `tok-${name}-2`)).read, ["app-a", "app-c"]);
  });

  test(`${name} with no application reads what it always did`, async () => {
    const all = (await scopesRead(name, {}, `tok-${name}-3`)).read;
    const blank = (await scopesRead(name, { application_ids: [" "] }, `tok-${name}-4`)).read;
    const empty = (await scopesRead(name, { application_ids: [] }, `tok-${name}-5`)).read;

    assert.ok(all.includes("organization") || all.length === APPS.length, all.join());
    assert.deepEqual(blank, all);
    assert.deepEqual(empty, all);
  });

  test(`${name} reads nothing for an application the caller does not have`, async () => {
    assert.deepEqual((await scopesRead(name, { application_ids: ["app-elsewhere"] }, `tok-${name}-6`)).read, []);
  });
}

for (const name of TOOLS) {
  test(`${name} refuses an application outside the list it was given, and reads nothing`, async () => {
    for (const scope of [{}, { organization_id: ORG }]) {
      const read = stubFetch();
      const args = { ...scope, application_id: "app-b", application_ids: ["app-a"] };
      const result = await withClient(`tok-${name}-7-${Object.keys(scope).length}`, (client) => client.callTool({ name, arguments: args }));

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^Error \[bad_request\]: application_id is not one of application_ids/);
      assert.deepEqual(read, []);
    }
  });

  test(`${name} with an application of the list reads that one alone`, async () => {
    const args = { organization_id: ORG, application_id: "app-b", application_ids: ["app-a", "APP-B"] };

    assert.deepEqual((await scopesRead(name, args, `tok-${name}-8`)).read, ["app-b"]);
  });
}

test("the figures are the sum of the given applications", async () => {
  const { result } = await scopesRead("didit_analytics", { application_ids: ["app-a", "app-c"] }, "tok-sum");
  const body = JSON.parse(result.content[0].text);

  assert.equal(body.request_breakdown.total_approved, 2);
  assert.deepEqual(body.per_app.map((app) => app.application_id).sort(), ["app-a", "app-c"]);
});

test("all kinds of sessions say what either kind could not read", async () => {
  const read = stubFetch();
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    /application\/app-b\/business-sessions\//.test(new URL(String(url)).pathname) ? json({ detail: "no" }, 403) : inner(url, init);
  const answer = await withClient("all-kinds-token", (client) =>
    client.callTool({ name: "didit_session_search", arguments: { organization_id: ORG, application_ids: ["app-a", "app-b"], session_kind: "all" } }),
  );
  const found = JSON.parse(answer.content[0].text);
  assert.ok(read.length > 0);
  assert.equal(found.skipped_apps, 1, JSON.stringify(found));
});

test("an order is kept when the call names one application, without its organization", async () => {
  const read = stubFetch();
  const answer = await withClient("ordering-token", (client) =>
    client.callTool({ name: "didit_session_search", arguments: { application_id: "app-b", ordering: "-created_at" } }),
  );
  assert.equal(answer.isError, undefined, answer.content[0].text);
  assert.deepEqual(read, ["app-b"]);
  const several = await withClient("ordering-token-2", (client) =>
    client.callTool({ name: "didit_session_search", arguments: { application_ids: ["app-a", "app-b"], ordering: "-created_at" } }),
  );
  assert.match(several.content[0].text, /ordering works in one application/);
});

test("an all-kinds session search has no offset of its own", async () => {
  stubFetch();
  const answer = await withClient("all-offset-token", (client) =>
    client.callTool({ name: "didit_session_search", arguments: { application_ids: ["app-a", "app-b"], session_kind: "all", offset: 20 } }),
  );
  assert.match(answer.content[0].text, /offset works in one kind/);
  const ordered = await withClient("all-ordering-token", (client) =>
    client.callTool({ name: "didit_session_search", arguments: { application_id: "app-a", session_kind: "all", ordering: "created_at" } }),
  );
  assert.match(ordered.content[0].text, /ordering works in one kind/);
  const hourly = await withClient("hourly-token", (client) =>
    client.callTool({ name: "didit_analytics", arguments: { application_id: "app-a", today_by_hour: true, country: "ESP" } }),
  );
  assert.match(hourly.content[0].text, /today_by_hour covers the whole application: country/);
});
