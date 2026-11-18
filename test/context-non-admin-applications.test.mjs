import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// didit_context_get told a Reader, Developer and Compliance Officer that their
// organization has no applications. It discovers applications through
// GET /organizations/me/{org}/applications/, the auth service route that only Owner and Admin
// may call ("Only organization owners and admins can manage applications."), so every other
// role's refusal became `applications: []` with `application_count: 0` and no flag.
//
// The same member can list the team (GET /organizations/{org}/members/), and their own row
// carries `accessible_applications` — the applications app-scoped tools already honour. The
// context must fall back to it, marked as membership-sourced with `mode` unknown, instead of
// reporting an empty organization; when even that cannot be read it must say the list is
// unknown, never zero.

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.MCP_DEFAULT_ORG;
delete process.env.MCP_DEFAULT_APP;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ORGS = [{ uuid: "org-1", name: "Acme" }];
const APP_ROWS = [
  { uuid: "app-1", name: "Acme Prod", mode: "live" },
  { uuid: "app-2", name: "Acme Sandbox", mode: "sandbox" },
];
const MEMBERS = [
  {
    uuid: "member-owner",
    user_id: "user-owner",
    identifier: "owner@acme.test",
    role: "Owner",
    accessible_applications: [{ uuid: "app-1", name: "Acme Prod" }, { uuid: "app-2", name: "Acme Sandbox" }],
  },
  {
    uuid: "member-reader",
    user_id: "user-reader",
    identifier: "reader@acme.test",
    role: "Reader",
    accessible_applications: [{ uuid: "app-1", name: "Acme Prod" }, { uuid: "app-2", name: "Acme Sandbox" }],
  },
];

/**
 * The auth service, as a signed-in non-admin sees it: the organization and its own member row
 * answer, the applications route refuses with the production message.
 *
 * `memberPages` serves the member list the way the real route does when asked with `?limit=`:
 * one `{count, next, previous, results}` page per request, advancing by `offset`. A page written
 * as `{ status }` is that page failing. Left out, the whole `members` list answers in one page.
 */
function stubAuth({ appsStatus = 200, membersStatus = 200, members = MEMBERS, memberPages } = {}) {
  const calls = [];
  // The query string each members request carried: the list is read page by page, not once.
  calls.params = [];
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    const path = target.pathname;
    calls.push(path);
    if (path === "/auth/v2/organizations/me/") return json(ORGS);
    if (path === "/auth/v2/organizations/me/org-1/applications/") {
      return appsStatus === 200
        ? json(APP_ROWS)
        : json({ detail: "Only organization owners and admins can manage applications." }, appsStatus);
    }
    if (path === "/auth/v2/users/me/") return json({ identifier: "reader@acme.test", full_name: "Rita Reader" });
    if (path === "/auth/v2/organizations/org-1/members/") {
      calls.params.push(target.search);
      if (memberPages) {
        const offset = Number(target.searchParams.get("offset") ?? 0);
        let start = 0;
        let index = memberPages.length - 1;
        for (let i = 0; i < memberPages.length; i++) {
          const size = Array.isArray(memberPages[i]) ? memberPages[i].length : 1;
          if (offset < start + size) {
            index = i;
            break;
          }
          start += size;
        }
        const page = memberPages[index];
        if (!Array.isArray(page)) return json({ detail: "Page unavailable." }, page.status);
        const count = memberPages.reduce((n, p) => n + (Array.isArray(p) ? p.length : 0), 0);
        return json({ count, next: index < memberPages.length - 1 ? "next" : null, previous: null, results: page });
      }
      return membersStatus === 200
        ? json({ count: members.length, results: members })
        : json({ detail: "You do not have permission to perform this action." }, membersStatus);
    }
    if (path === `${new URL(API).pathname}/organization/org-1/application/app-1/lists/`) {
      return json({ count: 0, results: [] });
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
  const client = new Client({ name: "context-non-admin-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (res) => res.content.map((c) => c.text).join("\n");

// Captured before the fix, on an Owner/Admin-shaped response: this exact bytes must not move.
const OWNER_PAYLOAD =
  '{"organizations":[{"organization_id":"org-1","organization_name":"Acme","applications":[{"application_id":"app-1","application_name":"Acme Prod","mode":"live"},{"application_id":"app-2","application_name":"Acme Sandbox","mode":"sandbox"}]}],"organization_count":1,"application_count":2,"default_organization_id":"org-1","hint":"Pass organization_id/application_id to target one scope, or omit them on *_search tools to aggregate across all apps. `mode` is the application\'s environment: a LIVE application bills every verification session created in it, a SANDBOX one mocks every provider and never bills. Read the field — never guess the environment from application_name."}';

test("a Reader gets their applications from their own membership row, not an empty organization", async () => {
  const calls = stubAuth({ appsStatus: 403 });

  const res = await callTool("didit_context_get", {}, "tok-reader-membership");

  assert.equal(res.isError, undefined, textOf(res));
  const payload = JSON.parse(textOf(res));
  const org = payload.organizations[0];
  assert.deepEqual(
    org.applications,
    [
      { application_id: "app-1", application_name: "Acme Prod" },
      { application_id: "app-2", application_name: "Acme Sandbox" },
    ],
    "the member's accessible applications, without an invented mode",
  );
  assert.equal(payload.application_count, 2);
  assert.equal(org.applications_source, "membership");
  assert.match(org.applications_note, /membership/i);
  assert.match(org.applications_note, /mode/i);
  assert.equal(org.applications_unknown, undefined);
  assert.equal(payload.applications_unknown, undefined);
  assert.ok(
    calls.indexOf("/auth/v2/organizations/me/org-1/applications/") <
      calls.indexOf("/auth/v2/organizations/org-1/members/"),
    `the applications route is still tried first, got:\n${calls.join("\n")}`,
  );
});

test("the applications route is refused, the membership is not read for an Owner/Admin (output unchanged)", async () => {
  const calls = stubAuth();

  const res = await callTool("didit_context_get", {}, "tok-owner-unchanged");

  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(textOf(res), OWNER_PAYLOAD);
  assert.ok(!calls.some((p) => p.endsWith("/members/") || p.endsWith("/users/me/")), calls.join("\n"));
});

test("when the fallback fails too, the organization says its applications are unknown — never zero", async () => {
  stubAuth({ appsStatus: 403, membersStatus: 403 });

  const res = await callTool("didit_context_get", {}, "tok-reader-fallback-failed");

  assert.equal(res.isError, undefined, textOf(res));
  const payload = JSON.parse(textOf(res));
  const org = payload.organizations[0];
  assert.equal(org.applications_unknown, true);
  assert.equal(org.applications, undefined, "an unknown list must not be an empty list");
  assert.equal(payload.applications_unknown, true);
  assert.equal(payload.application_count, undefined, "a blind count must not be reported as zero");
  assert.match(payload.applications_note, /unknown|could not be listed/i);
});

test("a member row with no accessible applications is a known empty list, not an unknown one", async () => {
  stubAuth({
    appsStatus: 403,
    members: [{ ...MEMBERS[1], accessible_applications: [] }],
  });

  const payload = JSON.parse(textOf(await callTool("didit_context_get", {}, "tok-reader-no-apps")));

  assert.deepEqual(payload.organizations[0].applications, []);
  assert.equal(payload.organizations[0].applications_unknown, undefined);
  assert.equal(payload.organizations[0].applications_source, "membership");
  assert.equal(payload.application_count, 0);
});

// `accessible_applications` is an expanded object list on the read serializer, but the write
// serializer takes bare UUIDs. A row that answers in the id-only shape must still give the person
// their applications; an entry the code cannot read must make the list UNKNOWN, never shorter or
// empty, because "you have no applications" is exactly the wrong answer this fallback removes.
const membershipApplications = async (apps, token) => {
  stubAuth({ appsStatus: 403, members: [{ ...MEMBERS[1], accessible_applications: apps }] });
  const payload = JSON.parse(textOf(await callTool("didit_context_get", {}, token)));
  return payload;
};

const UUID_1 = "3f6b1c2e-0a4d-4b8e-9c71-58d2f0a91b34";
const UUID_2 = "c0a7d5e2-71b3-4f68-8d20-6e4a9b1c3f57";

test("a member row whose applications are bare id strings gives those applications by id", async () => {
  const payload = await membershipApplications([UUID_1, UUID_2], "tok-reader-id-strings");

  const org = payload.organizations[0];
  assert.deepEqual(
    org.applications,
    [
      { application_id: UUID_1, application_name: UUID_1 },
      { application_id: UUID_2, application_name: UUID_2 },
    ],
    "the ids are what the app-scoped tools take; no mode is invented",
  );
  assert.equal(payload.application_count, 2);
  assert.equal(org.applications_source, "membership");
  assert.equal(org.applications_unknown, undefined);
});

test("a mixed member row (one expanded object, one id string) gives both applications", async () => {
  const payload = await membershipApplications([{ uuid: "app-1", name: "Acme Prod" }, UUID_2], "tok-reader-mixed");

  const org = payload.organizations[0];
  assert.deepEqual(org.applications, [
    { application_id: "app-1", application_name: "Acme Prod" },
    { application_id: UUID_2, application_name: UUID_2 },
  ]);
  assert.equal(payload.application_count, 2);
  assert.equal(org.applications_unknown, undefined);
});

for (const [label, unreadable] of [
  ["null", null],
  ["a number", 42],
]) {
  test(`a member row with an unreadable entry (${label}) reports unknown applications, not none`, async () => {
    const payload = await membershipApplications([{ uuid: "app-1", name: "Acme Prod" }, unreadable], `tok-reader-unreadable-${label}`);

    const org = payload.organizations[0];
    assert.equal(org.applications_unknown, true, "one unreadable entry makes the whole list unknown");
    assert.equal(org.applications, undefined, "the readable part must not be reported as the whole list");
    assert.equal(payload.applications_unknown, true);
    assert.equal(payload.application_count, undefined, "an unreadable list must not be counted as zero");
  });
}

test("a member row with an empty accessible_applications array is still a known empty list", async () => {
  const payload = await membershipApplications([], "tok-reader-empty-array");

  const org = payload.organizations[0];
  assert.deepEqual(org.applications, []);
  assert.equal(org.applications_unknown, undefined);
  assert.equal(payload.application_count, 0);
});

test("the single-application auto-resolve uses the membership applications a Reader can open", async () => {
  const calls = stubAuth({
    appsStatus: 403,
    members: [{ ...MEMBERS[1], accessible_applications: [{ uuid: "app-1", name: "Acme Prod" }] }],
  });

  const res = await callTool("didit_lists_list", {}, "tok-reader-autoresolve");

  assert.equal(res.isError, undefined, textOf(res));
  assert.ok(
    calls.includes("/v3/organization/org-1/application/app-1/lists/"),
    `expected the app-scoped lists call, got:\n${calls.join("\n")}`,
  );
});

const memberRequests = (calls) => calls.filter((p) => p === "/auth/v2/organizations/org-1/members/").length;
const memberRow = (identifier, apps) => ({
  uuid: `member-${identifier.split("@")[0]}`,
  identifier,
  role: "Reader",
  accessible_applications: apps,
});

test("a Reader whose own row is on page 2 of 3 still gets their applications", async () => {
  const calls = stubAuth({
    appsStatus: 403,
    memberPages: [
      [memberRow("first@acme.test", []), memberRow("second@acme.test", [])],
      [memberRow("third@acme.test", []), MEMBERS[1]],
      [memberRow("fourth@acme.test", [])],
    ],
  });

  const res = await callTool("didit_context_get", {}, "tok-reader-page-2");

  assert.equal(res.isError, undefined, textOf(res));
  const org = JSON.parse(textOf(res)).organizations[0];
  assert.deepEqual(
    org.applications,
    [
      { application_id: "app-1", application_name: "Acme Prod" },
      { application_id: "app-2", application_name: "Acme Sandbox" },
    ],
  );
  assert.equal(org.applications_source, "membership");
  assert.equal(org.applications_unknown, undefined);
  assert.equal(memberRequests(calls), 2, `the read stops at the page with the row, got:\n${calls.join("\n")}`);
});

test("a Reader whose own row is on page 1 costs one members request, not the whole list", async () => {
  const calls = stubAuth({
    appsStatus: 403,
    memberPages: [
      [MEMBERS[1], memberRow("second@acme.test", [])],
      [memberRow("third@acme.test", [])],
      [memberRow("fourth@acme.test", [])],
    ],
  });

  const payload = JSON.parse(textOf(await callTool("didit_context_get", {}, "tok-reader-page-1")));

  assert.equal(payload.application_count, 2);
  assert.equal(payload.organizations[0].applications_source, "membership");
  assert.equal(memberRequests(calls), 1, `no further page may be asked for, got:\n${calls.join("\n")}`);
  assert.match(calls.params[0], /limit=\d+/, "the read asks the list for a page, the way org/app discovery does");
});

test("a member page that cannot be read says the applications are unknown, not empty", async () => {
  const calls = stubAuth({
    appsStatus: 403,
    memberPages: [[memberRow("first@acme.test", []), memberRow("second@acme.test", [])], { status: 500 }],
  });

  const payload = JSON.parse(textOf(await callTool("didit_context_get", {}, "tok-reader-page-failed")));

  assert.equal(payload.organizations[0].applications_unknown, true);
  assert.equal(payload.organizations[0].applications, undefined, "a half-read list must not be an empty list");
  assert.equal(payload.applications_unknown, true);
  assert.equal(payload.application_count, undefined, "a blind count must not be reported as zero");
  assert.equal(memberRequests(calls), 2, "the first page was read and the second one failed");
});
