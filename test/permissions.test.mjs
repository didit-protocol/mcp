import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { PRIVILEGED_TOOL_DEFS } from "../dist/privileged-tools.js";
import { TOOL_PERMISSIONS, decidePermission } from "../dist/permissions.js";
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
  // A staff Bearer keeps the full catalog (staff tools included, filtered below). In the
  // public build the privileged module is the empty stub, so that Bearer would read as an
  // ordinary hosted user and lose the account-bootstrap / checkout tools: list as a bare
  // stdio client there instead.
  const asStaff = staff.size ? { authInfo: STAFF } : {};
  const catalog = await withClient({ hosted: false, ...asStaff }, async (c) =>
    (await c.listTools()).tools.map((t) => t.name).filter((name) => !staff.has(name)),
  );

  const unmapped = catalog.filter((name) => !(name in TOOL_PERMISSIONS));
  const stale = Object.keys(TOOL_PERMISSIONS).filter((name) => !catalog.includes(name));
  assert.deepEqual(unmapped, [], "tools without a permission entry");
  assert.deepEqual(stale, [], "permission entries for tools that no longer exist");
  for (const [name, permission] of Object.entries(TOOL_PERMISSIONS)) {
    if (permission !== null) assert.match(permission, /^(read|write|delete|list|create|approve):[a-z-]+$/, name);
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
  const audit = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
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
