import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { PRIVILEGED_TOOL_DEFS } from "../dist/privileged-tools.js";
import { KEY_ONLY_TOOLS } from "../dist/api-key-connection.js";
import { TOOL_PERMISSIONS, acceptedPermissions, decidePermission, currentAccessRefusal } from "../dist/permissions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The permission pre-check mirrors the backend's @has_privileges decorators tool by tool.
// It only ever refuses in enforce mode and only when the token carries the backend's
// permission strings and lacks the required one; a stdio env token (no permissions) and
// an unmapped tool are always allowed through to the backend, which stays authoritative.

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";

delete process.env.DIDIT_ACCESS_TOKEN;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

async function withClient({ hosted = true, authInfo } = {}, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(hosted ? { hosted: true } : {});
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo });
  }
  const client = new Client({ name: "permissions-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** A "reader" role token as introspection would populate it: read/list only, plus the
 * OAuth scope and claim strings that share the same array. */
const READER = {
  token: "tok-reader",
  clientId: "client-1",
  scopes: ["didit:verification", "didit:management", "email", "read:sessions", "list:sessions", "read:workflows"],
  extra: { sub: "user-1", organization_id: "org-1" },
};

const STAFF = { token: "tok-staff", clientId: "client-1", scopes: [], extra: { is_privileged: true } };

const textOf = (res) => res.content.map((c) => c.text).join("\n");

async function withMode(mode, fn) {
  const previous = process.env.MCP_PERMISSION_MODE;
  process.env.MCP_PERMISSION_MODE = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MCP_PERMISSION_MODE;
    else process.env.MCP_PERMISSION_MODE = previous;
  }
}

test("every catalog tool has a permission entry, and every entry names a catalog tool", async () => {
  const staff = new Set(PRIVILEGED_TOOL_DEFS.map((t) => t.name));
  // Bootstrap tools are local. Authentication setup needs a management grant.
  // Take the union so this checks both credential-specific catalogs in either build.
  const catalog = [];
  for (const authInfo of [undefined, { ...STAFF, scopes: ["didit:management"] }]) {
    await withClient({ hosted: false, authInfo }, async (client) => {
      const { tools } = await client.listTools();
      catalog.push(...tools.map(({ name }) => name).filter((name) => !staff.has(name)));
    });
  }

  // A key-only tool is on no person's catalog.
  catalog.push(...KEY_ONLY_TOOLS);

  const unmapped = catalog.filter((name) => !(name in TOOL_PERMISSIONS));
  const stale = Object.keys(TOOL_PERMISSIONS).filter((name) => !catalog.includes(name));
  assert.deepEqual(unmapped, [], "tools without a permission entry");
  assert.deepEqual(stale, [], "permission entries for tools that no longer exist");
  for (const [name, permission] of Object.entries(TOOL_PERMISSIONS)) {
    // A value is one permission, or the set an endpoint accepts any one of.
    const accepted = permission === null ? [] : typeof permission === "string" ? [permission] : permission;
    for (const one of accepted) assert.match(one, /^(read|write|delete|list|create|approve):[a-z-]+$/, name);
  }
});

const query = (overrides) => ({
  tool: "didit_session_delete",
  scopes: ["read:sessions"],
  mode: "enforce",
  tokenOrg: "org-1",
  targetOrg: "org-1",
  ...overrides,
});

test("decidePermission: allowed without permission strings, with the right one, or for unmapped tools", () => {
  assert.equal(decidePermission(query({ scopes: [] })), "allow");
  assert.equal(decidePermission(query({ scopes: undefined })), "allow");
  assert.equal(decidePermission(query({ scopes: ["didit:verification"] })), "allow");
  assert.equal(decidePermission(query({ scopes: ["delete:sessions"] })), "allow");
  assert.equal(decidePermission(query({ tool: "didit_not_a_tool" })), "allow");
  assert.equal(decidePermission(query({ mode: "off" })), "allow");
});

test("decidePermission: a role lacking the permission is denied in enforce mode, flagged in shadow mode", () => {
  assert.equal(decidePermission(query({})), "deny");
  assert.equal(decidePermission(query({ mode: "shadow" })), "would_deny");
  assert.equal(decidePermission(query({ targetOrg: undefined })), "deny", "no explicit org means the token's org");
});

test("decidePermission: only judges the organization the token's permissions describe", () => {
  // A multi-org user routes a call to another org by argument: those permissions say
  // nothing about that org, so the backend decides. A token without an org context is
  // never judged either.
  assert.equal(decidePermission(query({ targetOrg: "org-2" })), "allow");
  assert.equal(decidePermission(query({ tokenOrg: undefined, targetOrg: undefined })), "allow");
  assert.equal(decidePermission(query({ tokenOrg: undefined, targetOrg: "org-1" })), "allow");
});

// the call-time gate decides on the access service-didit-auth states for the
// organization the call acts in, not on the token that was verified when the connection opened.
test("currentAccessRefusal: the role, the application and the membership as service-didit-auth states them now", () => {
  const tool = "didit_webhook_create"; // write:webhooks
  const admin = { role: "Admin", permissions: ["read:webhooks", "write:webhooks"], accessibleApplications: ["app-1"] };
  assert.equal(currentAccessRefusal({ tool, access: admin, applicationId: "app-1" }), undefined, "an Admin is served");

  const demoted = currentAccessRefusal({ tool, access: { ...admin, role: "Reader", permissions: ["read:webhooks"] }, applicationId: "app-1" });
  assert.match(demoted, /Reader/, "the refusal names the role the member has now");
  assert.match(demoted, /write:webhooks/, "and the permission it lacks");
  assert.match(demoted, /Ask an organization owner or admin to grant/, "and what to do about it");
  assert.doesNotMatch(demoted, /changed it/, "no change is claimed: the token's permissions are not part of the question");

  // Only a privilege the connection actually signed in with can be reported as taken away.
  const taken = currentAccessRefusal({
    tool,
    access: { ...admin, role: "Reader", permissions: ["read:webhooks"] },
    applicationId: "app-1",
    signedInPermissions: ["read:webhooks", "write:webhooks"],
  });
  assert.match(taken, /changed it/);
  assert.match(taken, /nothing else is needed/i);

  const noApp = currentAccessRefusal({ tool, access: { ...admin, accessibleApplications: [] }, applicationId: "app-1" });
  assert.match(noApp, /application app-1/);
  assert.match(noApp, /ask an organization owner or admin to grant it to your role/i, "and what to do about it");
  assert.doesNotMatch(noApp, /removed it|changed it/, "no removal is asserted without evidence of one");

  // The application check is the call's application: with none named, a stale scope default
  // cannot refuse an organization-level tool.
  assert.equal(currentAccessRefusal({ tool, access: { ...admin, accessibleApplications: [] } }), undefined);

  for (const removed of [{ role: null, permissions: [], accessibleApplications: [] }, { role: "Reader", permissions: [], accessibleApplications: [] }]) {
    assert.match(currentAccessRefusal({ tool, access: removed, applicationId: "app-1" }), /membership/i, JSON.stringify(removed));
  }

  // An answer that says less than all of it only decides what it actually said.
  assert.equal(currentAccessRefusal({ tool, access: {}, applicationId: "app-1" }), undefined);
  assert.equal(currentAccessRefusal({ tool, access: { role: "Admin" }, applicationId: "app-1" }), undefined);
  assert.match(currentAccessRefusal({ tool, access: { role: "Admin", permissions: ["read:webhooks"] }, applicationId: "app-1" }), /write:webhooks/);
  assert.equal(currentAccessRefusal({ tool: "didit_context_get", access: admin, applicationId: "app-1" }), undefined, "no permission to check");
});

// An endpoint can accept either of two privileges (`accepted_org_permissions` on a DRF view): the
// session views take create:sessions or write:sessions, and holding either must pass.
test("currentAccessRefusal: an endpoint that accepts any one of several permissions", () => {
  const tool = "didit_session_create";
  assert.deepEqual(acceptedPermissions(tool), ["create:sessions", "write:sessions"]);

  const create = { role: "Developer", permissions: ["create:sessions"], accessibleApplications: ["app-1"] };
  assert.equal(currentAccessRefusal({ tool, access: create, applicationId: "app-1" }), undefined, "create:sessions alone is enough");

  const write = { role: "Admin", permissions: ["write:sessions"], accessibleApplications: ["app-1"] };
  assert.equal(currentAccessRefusal({ tool, access: write, applicationId: "app-1" }), undefined, "write:sessions alone is enough");

  const reader = { role: "Reader", permissions: ["read:sessions", "list:sessions"], accessibleApplications: ["app-1"] };
  const refusal = currentAccessRefusal({ tool, access: reader, applicationId: "app-1" });
  assert.match(refusal, /Reader/);
  assert.match(refusal, /'create:sessions' or 'write:sessions'/, "the refusal names both accepted privileges");

  // An alias (a wakeshift watch tool) is checked as the tool it reads but named as the caller called it.
  assert.equal(
    currentAccessRefusal({
      tool: "didit_session_watch",
      permissionFor: "didit_session_get_decision",
      access: { role: "Admin", permissions: ["read:sessions"] },
      applicationId: "app-1",
    }),
    undefined,
  );
  const aliased = currentAccessRefusal({
    tool: "didit_session_watch",
    permissionFor: "didit_session_get_decision",
    // A permission the watched tool does not accept: read:sessions OR list:sessions would pass it.
    access: { role: "Reader", permissions: ["read:workflows"] },
    applicationId: "app-1",
  });
  assert.match(aliased, /didit_session_watch requires/, "the message names the tool the caller called");
  assert.doesNotMatch(aliased, /didit_session_get_decision/);
});

// an internal issue finding 3: an answer that lists no permissions of its own decides only the tools that
// accept one. A tool with no role check (the membership routes) runs whatever the role grants, so an
// empty list must not refuse it with the "removed or suspended" message.
test("currentAccessRefusal: an empty permission list only refuses a tool that accepts a permission", () => {
  const membershipOnly = { role: "Reader", permissions: [], accessibleApplications: [] };
  assert.equal(currentAccessRefusal({ tool: "didit_org_list_applications", access: membershipOnly }), undefined, "no role check, nothing to lack");

  // Having no role there is still a removal, whatever the tool checks.
  assert.match(currentAccessRefusal({ tool: "didit_org_list_applications", access: { ...membershipOnly, role: null } }), /membership/i);
  // And a tool that accepts one is still refused for an empty list.
  assert.match(currentAccessRefusal({ tool: "didit_webhook_create", access: membershipOnly }), /membership/i);
});

// an internal issue finding 4: a GET is accepted by the backend for a role holding read:X OR list:X
// (core/permissions.py, _accepted_permissions), so the map names both for every read tool.
test("the map accepts read:X or list:X for a read tool, as the backend does for a safe method", () => {
  assert.deepEqual(acceptedPermissions("didit_session_list"), ["list:sessions", "read:sessions", "list:businesses", "read:businesses"]);
  // A role that sees only business verifications reaches their list; the API checks each kind.
  const businessOnly = { role: "Custom", permissions: ["list:businesses"], accessibleApplications: ["app-1"] };
  assert.equal(currentAccessRefusal({ tool: "didit_session_search", access: businessOnly, applicationId: "app-1" }), undefined);
  assert.deepEqual(acceptedPermissions("didit_session_get_decision"), ["read:sessions", "list:sessions"]);

  const readOnly = { role: "Custom", permissions: ["read:sessions"], accessibleApplications: ["app-1"] };
  assert.equal(currentAccessRefusal({ tool: "didit_session_list", access: readOnly, applicationId: "app-1" }), undefined, "read:sessions alone lists sessions");
  assert.equal(decidePermission({ ...query({ tool: "didit_session_get_decision", scopes: ["list:sessions"] }) }), "allow");

  // A write is still the exact permission: list: does not stand in for write:.
  const writer = { role: "Custom", permissions: ["list:webhooks"], accessibleApplications: ["app-1"] };
  assert.match(currentAccessRefusal({ tool: "didit_webhook_create", access: writer, applicationId: "app-1" }), /write:webhooks/);
});

test("decidePermission: any one of an accepted set allows the call", () => {
  assert.equal(decidePermission(query({ tool: "didit_session_create", scopes: ["create:sessions"] })), "allow");
  assert.equal(decidePermission(query({ tool: "didit_session_create", scopes: ["write:sessions"] })), "allow");
  assert.equal(decidePermission(query({ tool: "didit_session_create", scopes: ["read:sessions"] })), "deny");
});

test("enforce mode: a reader calling a delete gets missing_scope and the backend is never called", async () => {
  const calls = stubFetch({});

  const res = await withMode("enforce", () =>
    withClient({ authInfo: READER }, (c) =>
      c.callTool({
        name: "didit_session_delete",
        arguments: { organization_id: "org-1", application_id: "app-1", session_id: "11111111-1111-1111-1111-111111111111", confirm: true },
      }),
    ),
  );

  assert.equal(res.isError, true);
  assert.match(textOf(res), /^Error \[missing_scope\]/);
  assert.match(textOf(res), /delete:sessions/);
  assert.equal(calls.length, 0, "the refusal must happen before any backend request");
});

test("enforce mode: a call routed to another organization is left to the backend", async () => {
  const calls = stubFetch({});

  const res = await withMode("enforce", () =>
    withClient({ authInfo: READER }, (c) =>
      c.callTool({
        name: "didit_session_delete",
        arguments: { organization_id: "org-2", application_id: "app-1", session_id: "11111111-1111-1111-1111-111111111111", confirm: true },
      }),
    ),
  );

  assert.equal(res.isError, true);
  assert.doesNotMatch(textOf(res), /missing_scope/);
  assert.ok(calls.length > 0, "the backend must decide for an organization the token does not describe");
});

test("enforce mode: the same reader can still run what its role allows", async () => {
  stubFetch({ [`${API}/organization/org-1/application/app-1/sessions/`]: { count: 0, results: [] } });

  const res = await withMode("enforce", () =>
    withClient({ authInfo: READER }, (c) =>
      c.callTool({ name: "didit_session_list", arguments: { organization_id: "org-1", application_id: "app-1" } }),
    ),
  );

  assert.equal(res.isError, undefined, textOf(res));
});

test("shadow mode (default): the call proceeds to the backend and the audit line records would_deny", async () => {
  const calls = stubFetch({});
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));

  let res;
  try {
    res = await withClient({ authInfo: READER }, (c) =>
      c.callTool({
        name: "didit_session_delete",
        arguments: { organization_id: "org-1", application_id: "app-1", session_id: "11111111-1111-1111-1111-111111111111", confirm: true },
      }),
    );
  } finally {
    console.error = original;
  }

  assert.equal(res.isError, true, "the stub backend answers 404, so the call still errors");
  assert.match(textOf(res), /^Error \[not_found\]/, "shadow mode must not produce missing_scope");
  assert.ok(calls.length > 0, "shadow mode lets the backend decide");
  const audit = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(JSON.parse(l).message));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].permission_check, "would_deny");
});

test("enforce mode hides from tools/list what the role cannot run; shadow mode lists everything", async () => {
  const names = (mode) =>
    withMode(mode, () => withClient({ authInfo: READER }, async (c) => (await c.listTools()).tools.map((t) => t.name)));

  const enforced = await names("enforce");
  assert.ok(enforced.includes("didit_session_list"));
  assert.ok(!enforced.includes("didit_session_delete"));

  const shadowed = await names("shadow");
  assert.ok(shadowed.includes("didit_session_delete"));
});
