import { createRequire } from "node:module";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

// a role change, an application-access change or a removal has to reach a client that is
// ALREADY connected. Found on production (hosted MCP v5.1.67, 18 Nov 2026): a member demoted from
// Admin to Reader in the console kept the Admin role on the open MCP connection, and only a fresh
// sign-in picked it up.
//
// This drives the real hosted HTTP transport the way a connector does (initialize, then tool calls)
// against two stand-ins that answer with the real services' caching rules:
//   * service-didit-auth's introspection reads the member's CURRENT role (its response cache is
//     version-bumped whenever a membership changes), so its answer changes the moment the console
//     does — it is the source of truth for permissions;
//   * service-didit-verification decides a call on its own introspection cache, per
//     token/organization/application, for INTROSPECT_CACHE_TIMEOUT = 600 s
//     (core/utils/authentication.py), so a call it decides on its own stays on the old role for up
//     to ten minutes after a change.
// Nothing here is Didit's real backend: the counts and the table below are the harness's. The
// staging matrix the issue asks for (real sign-in, real console change) needs an Owner and a
// disposable second member on staging, which this run did not have.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/auth/v2/introspect/";
process.env.DIDIT_AUTH_BASE_URL = "https://auth.example.test/auth/v2";
process.env.DIDIT_API_BASE_URL = "https://api.example.test/v3";
delete process.env.MCP_DEFAULT_ORG;
// Production runs the default mode (`deploy/prod.tfvars` sets none), and the live check refuses in
// every mode, so the evidence must come from the default one.
delete process.env.MCP_PERMISSION_MODE;
delete process.env.MCP_PUBLIC_DISCOVERY;

const require = createRequire(import.meta.url);
const { createHttpApp } = require("../dist/http.js");

const ORG = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const WORKFLOW = "44444444-4444-4444-8444-444444444444";
// A second organisation the same person belongs to, for the cross-organisation fan-out.
const ORG2 = "66666666-6666-4666-8666-666666666666";
const APP2 = "77777777-7777-4777-8777-777777777777";
// A SECOND application of the first organisation, for the cross-application fan-out.
const APP3 = "88888888-8888-4888-8888-888888888888";
// A person's access token is a JWT; a string with no dot would be introspected as an API key.
const TOKEN = "header.payload.signature";

// A Reader's role as service-didit-auth reports it: it lists and reads sessions and members, but creates nothing.
const READER = ["read:webhooks", "read:sessions", "list:sessions", "read:applications", "list:applications", "list:members"];
const ADMIN = [
  ...READER,
  "write:webhooks", "delete:webhooks", "create:sessions", "write:sessions", "write:members",
  // The reads the fan-out tests below use: an Admin reads users, analytics and the audit log.
  "read:users", "list:users", "read:analytics", "list:analytics", "read:audit-logs", "list:audit-logs",
];

/** The organisation's current state — what an Owner just changed in the console. `apps` is what the
 *  membership routes list for it (the 60 s organisation map, which keeps an application for up to a
 *  minute after the access to it is removed); `accessibleApplications` is what the live answer says. */
const organization = {
  role: "admin",
  accessibleApplications: [APP],
  apps: [{ uuid: APP, name: "Primary" }],
  // The shape `org_permissions` arrives in: service-didit-auth sends an array today, but RFC 7662
  // scope values are space-delimited and the token verifier accepts both, so the per-call read has
  // to as well (an internal issue review).
  permissionsShape: "array",
};
/** The second organisation: listed by the membership routes only while the person belongs to it. */
const second = { visible: false, role: "admin", accessibleApplications: [APP2] };

const membershipOf = (orgId) => (orgId === ORG2 ? second : organization);

const ROLE_SCRIPTS = {
  admin: { name: "Admin", permissions: ADMIN },
  reader: { name: "Reader", permissions: READER },
  removed: { name: "Reader", permissions: [] },
  // Still a member, with a custom role that carries only one of the two permissions a GET accepts.
  custom: { name: "Session Reader", permissions: ["read:sessions"] },
  // No longer in the organisation: service-didit-auth answers `org_role: null` for it.
  absent: { name: null, permissions: [] },
};

/** What the backend decided, per call: what it was asked, what it answered, and who decided. */
const evidence = [];
const webhookPosts = [];
const sessionPosts = [];
const vendorUserLists = [];
const analyticsRequests = [];
const auditLogLists = [];
const sessionsCreated = [];
const sessionLists = [];
/** The flat `/session/{id}/…` calls (decision, update-status, delete): they name no organization. */
const sessionOnlyCalls = [];
/** Every live membership question asked (an introspection carrying `requested_org`), in order. */
const liveQuestions = [];
/** The exact session paths requested: an organization-wide read and a per-application read differ. */
const sessionListPaths = [];
let backendIntrospections = 0;
// The verification service's own introspection cache: one entry per (organization, application) for
// INTROSPECT_CACHE_TIMEOUT = 600 s, exactly like production (core/utils/authentication.py:37).
const INTROSPECT_CACHE_MS = 600_000;
const backendCache = new Map();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * service-didit-auth's answer for the token, resolved from live membership state.
 *
 * Production shape: the connect introspection sends no `requested_org` (deploy/prod.tfvars sets no
 * MCP_DEFAULT_ORG), and the service then answers get_empty_organization_data
 * (authorizations/views/tokens.py:820) — `org_role: null`, `org_permissions: []`, no applications
 * — so the verified token carries no permission strings. Only the per-call read, which passes
 * `requested_org`, gets the member's role.
 */
function introspected(requestedOrg, token) {
  const base = {
    active: true,
    // A "Log in with Didit" grant: the only member credential the hosted server accepts
    // (auth/accepted-credentials.ts).
    token_use: "mcp",
    sub: "5bfe5319-625d-487c-a9c3-8f3cf50750b8",
    identifier: "member@example.test",
    claims: [],
    scope: "didit:verification didit:management",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  if (!requestedOrg) return { ...base, org_role: null, org_permissions: [], accessible_applications: [] };

  const member = membershipOf(requestedOrg);
  const script = ROLE_SCRIPTS[member.role];
  return {
    ...base,
    organization_id: requestedOrg,
    org_role: script.name,
    org_permissions: member.permissionsShape === "string" ? script.permissions.join(" ") : script.permissions,
    accessible_applications: member.accessibleApplications,
  };
}

/** service-didit-verification deciding a call: its own cached introspection answer, then the rule. */
function backendPermissions(application = APP) {
  const key = `${ORG}:${application}`;
  const now = Date.now();
  const cached = backendCache.get(key);
  if (cached && now - cached.at < INTROSPECT_CACHE_MS) return cached.permissions;

  backendIntrospections += 1;
  const permissions = introspected(ORG).org_permissions.slice();
  backendCache.set(key, { at: now, permissions });

  return permissions;
}

/** The permission classes each view runs: SessionView/SessionV2View accept either privilege. */
const sessionWritable = () => backendPermissions().some((p) => p === "create:sessions" || p === "write:sessions");
// A safe method accepts read:X or list:X (core/permissions.py, _accepted_permissions), as the MCP's
// own map now says.
const sessionReadable = () => backendPermissions().some((p) => p === "list:sessions" || p === "read:sessions");
// The body core/exceptions.py PermissionRequired answers: a role refusal always carries its code.
const forbid = () =>
  json({ detail: "You do not have permission to perform this action.", code: "permission_denied", missing_permissions: [] }, 403);
// A 403 the session create answers for a reason that is not the role (balance, plan), or null.
let sessionRefusal = null;

function reset() {
  organization.role = "admin";
  organization.accessibleApplications = [APP];
  organization.apps = [{ uuid: APP, name: "Primary" }];
  organization.permissionsShape = "array";
  vendorUserLists.length = 0;
  analyticsRequests.length = 0;
  auditLogLists.length = 0;
  liveQuestions.length = 0;
  second.visible = false;
  second.role = "admin";
  second.accessibleApplications = [APP2];
  webhookPosts.length = 0;
  sessionPosts.length = 0;
  sessionsCreated.length = 0;
  sessionLists.length = 0;
  sessionListPaths.length = 0;
  sessionOnlyCalls.length = 0;
  backendCache.clear();
  backendIntrospections = 0;
  sessionRefusal = null;
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const path = target.split("?")[0];
  if (target === process.env.DIDIT_OIDC_DISCOVERY_URL) {
    return json({
      issuer: "https://business.didit.me",
      authorization_endpoint: "https://business.didit.me/authorize",
      token_endpoint: "https://business.didit.me/api/auth/oauth-token",
      registration_endpoint: "https://business.didit.me/api/auth/oauth-register",
    });
  }
  if (target === process.env.MCP_OAUTH_INTROSPECT_URL) {
    const body = JSON.parse(String(init.body ?? "{}"));
    if (body.requested_org) liveQuestions.push(body.requested_org);
    return json(introspected(body.requested_org, body.token));
  }
  // The membership routes take paging parameters, so match the path without the query.
  if (path === "https://auth.example.test/auth/v2/organizations/me/") {
    const results = [{ uuid: ORG, name: "Acme" }];
    if (second.visible) results.push({ uuid: ORG2, name: "Acme Two" });
    return json({ count: results.length, results });
  }
  if (path === `https://auth.example.test/auth/v2/organizations/me/${ORG}/applications/`) {
    // The membership route: cached by the MCP for 60 s, so it keeps an application the membership
    // may have lost since — which is exactly what the live answer has to override.
    return json({ count: organization.apps.length, results: organization.apps });
  }
  if (path === `https://auth.example.test/auth/v2/organizations/me/${ORG2}/applications/`) {
    return json({ count: 1, results: [{ uuid: APP2, name: "Secondary" }] });
  }
  if (path === `https://api.example.test/v3/organization/${ORG}/application/${APP}/webhook/destinations/`) {
    webhookPosts.push({ at: Date.now(), role: organization.role });
    if (!backendPermissions().includes("write:webhooks")) return forbid();
    return json({ uuid: "33333333-3333-4333-8333-333333333333", label: "ops", url: "https://example.test/hook" });
  }
  if (path === `https://api.example.test/v3/organization/${ORG}/application/${APP}/sessions/`) {
    sessionLists.push({ at: Date.now(), org: ORG, role: organization.role });
    sessionListPaths.push(path);
    // The endpoint's own rule (application.py:123): list:sessions, or read:sessions on a GET.
    if (!sessionReadable()) return forbid();
    return json({
      count: 1,
      results: [{ session_id: `session-${APP.slice(0, 8)}`, application_id: APP, created_at: new Date().toISOString() }],
    });
  }
  // The organization-wide list a cross-organisation fan-out reads (application.py:448).
  const orgSessions = path.match(/^https:\/\/api\.example\.test\/v3\/organization\/([^/]+)\/sessions\/$/);
  if (orgSessions) {
    const orgId = orgSessions[1];
    sessionLists.push({ at: Date.now(), org: orgId, role: membershipOf(orgId).role });
    sessionListPaths.push(path);
    if (!sessionReadable()) return forbid();
    // One row per application of the organization, tagged with it — the shape the organization-wide
    // list answers with, so a row of an application the membership lost can be recognised.
    const apps = orgId === ORG ? organization.apps : [{ uuid: APP2, name: "Secondary" }];
    return json({
      count: apps.length,
      results: apps.map((app) => ({
        session_id: `session-${app.uuid.slice(0, 8)}`,
        application_id: app.uuid,
        created_at: new Date().toISOString(),
      })),
    });
  }
  // The FLAT per-session routes (tools/sessions.ts): decision, update-status and delete take only a
  // session id, so the call names no organization and the server has no membership to ask about.
  // The verification service decides them from its own cached answer for the session's organization.
  const flatSession = path.match(/^https:\/\/api\.example\.test\/v3\/session\/([^/]+)\/(decision|update-status|delete)\/$/);
  if (flatSession) {
    const [, sessionId, action] = flatSession;
    sessionOnlyCalls.push({ action, method: init.method ?? "GET", role: organization.role });
    if (!sessionReadable()) return forbid();
    return json({ session_id: sessionId, status: "Approved" });
  }
  if (path === "https://api.example.test/v3/session/") {
    sessionPosts.push({ at: Date.now(), role: organization.role });
    if (sessionRefusal) return json(sessionRefusal, 403);
    if (!sessionWritable()) return forbid();
    sessionsCreated.push({ at: Date.now() });
    return json({ session_id: "55555555-5555-4555-8555-555555555555", url: "https://verify.example.test/s/1", status: "Not Started" });
  }
  if (path === `https://api.example.test/v3/organization/${ORG}/application/${APP}/sessions/imports/providers/`) {
    return json({ results: [] });
  }
  // A per-app directory read (no organization-wide endpoint), the cross-application fan-out.
  const vendorUsers = path.match(/^https:\/\/api\.example\.test\/v3\/organization\/([^/]+)\/application\/([^/]+)\/vendor-users\/$/);
  if (vendorUsers) {
    const [, orgId, appId] = vendorUsers;
    vendorUserLists.push({ org: orgId, app: appId });
    return json({ count: 1, results: [{ vendor_data: `customer-of-${appId.slice(0, 4)}`, status: "Approved" }] });
  }
  // The per-application analytics the aggregate tool merges (there is no organization-level route).
  const analytics = path.match(/^https:\/\/api\.example\.test\/v3\/organization\/([^/]+)\/application\/([^/]+)\/analytics\/$/);
  if (analytics) {
    const [, orgId, appId] = analytics;
    analyticsRequests.push({ org: orgId, app: appId });
    return json({
      request_breakdown: { total_approved: 1 },
      previous_request_breakdown: {},
      original_status_stats: { Approved: 1 },
      workflow_funnel_stats: {},
      warning_stats: {},
      resubmission_stats: {},
    });
  }
  // The organization's audit log: an organization-level route that also takes an application filter.
  if (path === `https://api.example.test/v3/audit/${ORG}/audit-logs/`) {
    auditLogLists.push({ at: Date.now() });
    return json({ count: 1, results: [{ action: "member.updated", description: "Role changed" }] });
  }
  return json({ results: [] });
};

/** The Bearer the connection opened with: one per test, so the per-token org map is its own. */
let currentToken = TOKEN;

/** One JSON-RPC POST to the real hosted endpoint, answered like a connector's transport. */
function post(server, body) {
  const { port } = server.address();
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${currentToken}`,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          const data = raw
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())
            .filter(Boolean);
          resolve({ status: res.statusCode, raw, rpc: data.length > 0 ? JSON.parse(data[data.length - 1]) : JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

let nextId = 1;
function callTool(server, name, args = {}) {
  return post(server, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
}

/** A NEW connection, the way a connector opens one: what the token was verified as is now fixed.
 *  `token` gives a test its own organisation map, which is cached per token for 60 s. */
async function connect(token = TOKEN) {
  currentToken = token;
  const server = (await createHttpApp()).listen(0);
  const initialize = await post(server, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } },
  });
  assert.equal(initialize.status, 200);

  return server;
}

/** The JSON-RPC answer post() resolved (the envelope lives under `.rpc`). */
const text = (response) => response.rpc.result?.content?.[0]?.text ?? "";
const refused = (response) => response.rpc.result?.isError === true;

/** "Allowed" means the backend ran the write and answered it; anything else is a refusal. */
function createWebhook(server) {
  return callTool(server, "didit_webhook_create", {
    organization_id: ORG,
    application_id: APP,
    label: "ops",
    url: "https://example.test/hook",
  });
}

function createSession(server) {
  return callTool(server, "didit_session_create", {
    organization_id: ORG,
    application_id: APP,
    workflow_id: WORKFLOW,
  });
}

function listSessions(server) {
  return callTool(server, "didit_session_list", { organization_id: ORG, application_id: APP, limit: "1" });
}

/** The documented default: the organisation only, so the server resolves the one application. */
function createWebhookWithoutIds(server) {
  return callTool(server, "didit_webhook_create", {
    organization_id: ORG,
    label: "ops",
    url: "https://example.test/hook",
  });
}

test("a demotion, an application-access change and a removal reach an already connected client", async () => {
  reset();
  const server = await connect();
  try {
    // 1. Admin: the write is allowed, as the reporter saw before the demotion.
    const asAdmin = await createWebhook(server);
    evidence.push({ step: "Admin, before the change", result: refused(asAdmin) ? "refused" : "allowed", posts: webhookPosts.length });
    assert.equal(refused(asAdmin), false, `an Admin call must be allowed, got: ${text(asAdmin)}`);
    assert.equal(webhookPosts.length, 1);

    // 2. An Owner demotes the member to Reader. The SAME connection calls again immediately: the
    //    very next call must be refused, and the refusal must say what happened in plain words.
    organization.role = "reader";
    const demoted = await createWebhook(server);
    const demotedText = text(demoted);
    evidence.push({ step: "Reader, next call", result: refused(demoted) ? "refused" : "allowed", posts: webhookPosts.length, text: demotedText });
    assert.equal(refused(demoted), true, "after a demotion the next call must be refused");
    assert.equal(webhookPosts.length, 1, "the MCP server must not forward a call the member's current role may not make");
    assert.match(demotedText, /Reader/, "the refusal names the role the member has now");
    assert.match(demotedText, /write:webhooks/, "the refusal names the permission the role lacks");
    assert.match(demotedText, /Ask an organization owner or admin to grant/, "the refusal says what to do about it");
    assert.match(demotedText, /(reconnect|sign(ed)? in again)/i, "and when a reconnect is what is left to do");
    // The connect introspection carries no permission strings (production shape), so the refusal
    // cannot know the privilege used to be there: it must not claim a change that it cannot see.
    assert.doesNotMatch(demotedText, /changed it|removed it/, "no change is asserted without evidence of one");

    // 3. The Owner removes the application from the member's access. Next call: refused.
    organization.role = "admin";
    organization.accessibleApplications = [];
    const noApp = await createWebhook(server);
    const noAppText = text(noApp);
    evidence.push({ step: "Application access removed, next call", result: refused(noApp) ? "refused" : "allowed", posts: webhookPosts.length, text: noAppText });
    assert.equal(refused(noApp), true, "after losing the application the next call must be refused");
    assert.equal(webhookPosts.length, 1, "the MCP server must not forward a call to an application the member cannot open");
    assert.match(noAppText, /application/i, "the refusal names the application access that was removed");

    // 4. The Owner removes the member from the organisation. Next call: refused.
    organization.role = "removed";
    const removed = await createWebhook(server);
    const removedText = text(removed);
    evidence.push({ step: "Removed from the organisation, next call", result: refused(removed) ? "refused" : "allowed", posts: webhookPosts.length, text: removedText });
    assert.equal(refused(removed), true, "after a removal the next call must be refused");
    assert.equal(webhookPosts.length, 1, "the MCP server must not forward a call for someone who is no longer a member");
    assert.match(removedText, /membership/i, "the refusal says the membership is gone");
  } finally {
    console.log(JSON.stringify({ table: evidence, backendIntrospections, webhookPosts }, null, 2));
    server.close();
  }
});

test("a demotion reaches didit_session_create, whose endpoint accepts create:sessions or write:sessions", async () => {
  reset();
  const server = await connect();
  try {
    const asAdmin = await createSession(server);
    assert.equal(refused(asAdmin), false, `an Admin creates sessions, got: ${text(asAdmin)}`);
    assert.equal(sessionPosts.length, 1);

    // Demoted to Reader on the same connection: the headline harm of the report is that the person
    // can still create sessions after an Owner took that away.
    organization.role = "reader";
    const demoted = await createSession(server);
    const demotedText = text(demoted);
    evidence.push({ step: "Reader creates a session, next call", result: refused(demoted) ? "refused" : "allowed", posts: sessionPosts.length, text: demotedText });
    assert.equal(refused(demoted), true, "a Reader must not create a session on the next call");
    assert.equal(sessionPosts.length, 1, "the create must never reach the backend after the demotion");
    assert.match(demotedText, /Reader/);
    assert.match(demotedText, /'create:sessions' or 'write:sessions'/, "the refusal names both privileges the endpoint accepts");
  } finally {
    server.close();
  }
});

test("a promotion from Reader is served on the next call when the backend has no cached answer", async () => {
  reset();
  organization.role = "reader";
  const server = await connect();
  try {
    // The connection was opened, and its token verified, while the member was a Reader.
    organization.role = "admin";
    const promoted = await createSession(server);
    evidence.push({ step: "Reader promoted, next call", result: refused(promoted) ? "refused" : "allowed", posts: sessionPosts.length, text: text(promoted) });
    assert.equal(refused(promoted), false, `a promoted member must be served at once, got: ${text(promoted)}`);
    assert.equal(sessionPosts.length, 1);
  } finally {
    server.close();
  }
});

test("a promotion the verification service has not applied yet says so instead of a bare forbidden", async () => {
  reset();
  organization.role = "reader";
  const server = await connect();
  try {
    // The Reader's read reached the backend, so its 600 s cache now holds the Reader answer.
    const read = await listSessions(server);
    assert.equal(refused(read), false, `a Reader lists sessions, got: ${text(read)}`);
    assert.equal(sessionLists.length, 1);

    organization.role = "admin";
    const written = await createSession(server);
    const writtenText = text(written);
    evidence.push({ step: "Promoted Admin, stale backend answer", result: refused(written) ? "refused" : "allowed", posts: sessionPosts.length, text: writtenText });
    assert.equal(refused(written), true, "the verification service still refuses from its cached Reader answer");
    assert.equal(sessionPosts.length, 1, "the gate allows it (the role is Admin now) and the backend refuses it");
    assert.equal(sessionsCreated.length, 0, "no session is created while the backend holds the old role");
    assert.match(writtenText, /although your current role in this organization carries/, "the message says the live role already allows it");
    assert.match(writtenText, /600 seconds|10 minutes/, "and states the bound");
    assert.doesNotMatch(writtenText, /^Error \[forbidden\]/, "never a bare forbidden");

    // The cached answer expires (600 s): the same connection, no reconnect, is served.
    backendCache.clear();
    const afterwards = await createSession(server);
    evidence.push({ step: "After the 600 s bound", result: refused(afterwards) ? "refused" : "allowed", posts: sessionPosts.length });
    assert.equal(refused(afterwards), false, `inside the bound the write must succeed, got: ${text(afterwards)}`);
    assert.equal(sessionsCreated.length, 1);
  } finally {
    server.close();
  }
});

// Production 18-20 Nov 2026: a live AML screen without balance, a wallet screen and a network read
// on a plan without them were all answered "your role has not reached the service yet, retry in 10
// minutes"; the agent retried the same call and gave up. Only `permission_denied` is about the role.
test("a refusal that is not about the role passes the backend's reason on, never the role-cache wait", async () => {
  const refusals = [
    { error: "You don't have enough credits to perform this request. Please top up at https://business.didit.me" },
    { detail: "Not enough credits for this screening.", code: "insufficient_credits" },
    { detail: "Network investigation is available on the Scale plan.", code: "plan_upgrade_required" },
  ];

  for (const body of refusals) {
    reset();
    sessionRefusal = body;
    const server = await connect();
    try {
      const attempt = await createSession(server);
      const attemptText = text(attempt);
      evidence.push({ step: `Admin, backend 403 ${body.code ?? "uncoded"}`, result: refused(attempt) ? "refused" : "allowed", text: attemptText });
      assert.equal(refused(attempt), true);
      // URLs in error text are redacted by sanitizeText, as in every error: compare the reason without them.
      const reason = (body.detail ?? body.error).replace(/https?:\/\/\S+/g, "").trim();
      assert.ok(attemptText.includes(reason), `the backend's own reason reaches the model, got: ${attemptText}`);
      if (body.code) assert.match(attemptText, new RegExp(body.code), "and its machine code");
      assert.doesNotMatch(attemptText, /600 seconds|10 minutes|own copy of a role/, "never the role-cache wait");
      assert.doesNotMatch(attemptText, /different role/, "never a role hint for a refusal about something else");
    } finally {
      server.close();
    }
  }
});

test("a Reader who never had the privilege is told to ask for it, not told a role change happened", async () => {
  reset();
  organization.role = "reader";
  const server = await connect();
  try {
    // No change at all: this member was a Reader when the connection opened, and is one now. This is
    // the ordinary refusal the tools/list still offers in the default shadow mode.
    const attempt = await createWebhook(server);
    const attemptText = text(attempt);
    evidence.push({ step: "Reader from the start, write", result: refused(attempt) ? "refused" : "allowed", text: attemptText });
    assert.equal(refused(attempt), true, "a Reader may not create a webhook");
    assert.equal(webhookPosts.length, 0);
    assert.match(attemptText, /Reader/);
    assert.match(attemptText, /write:webhooks/);
    assert.match(attemptText, /Ask an organization owner or admin to grant/);
    assert.doesNotMatch(attemptText, /changed it|removed it/, "no owner or admin changed anything on this connection");
  } finally {
    server.close();
  }
});

test("losing the only application does not refuse an organization-level call", async () => {
  reset();
  const server = await connect();
  try {
    const before = await callTool(server, "didit_org_list_members", { organization_id: ORG });
    assert.equal(refused(before), false, `an Admin lists members, got: ${text(before)}`);

    // The member's access to the organization's only application is removed. Listing members is an
    // organization-level call: it declares no application_id, so no application is judged for it,
    // even though the organization map would resolve a default for an application tool.
    organization.accessibleApplications = [];
    const after = await callTool(server, "didit_org_list_members", { organization_id: ORG });
    const afterText = text(after);
    evidence.push({ step: "Application access removed, organization-level call", result: refused(after) ? "refused" : "allowed", text: afterText });
    assert.equal(refused(after), false, `listing members is not an application call, got: ${afterText}`);
    assert.doesNotMatch(afterText, /does not include access to application/, "the cached application default is not a membership verdict");
  } finally {
    server.close();
  }
});

// an internal issue finding 1: the application the call ACTUALLY uses, when the call names none.
// `application_id` is documented as optional ("resolved automatically when you own exactly one
// application"), and that default comes from the organisation map, which is cached for 60 s. The
// live list of applications the membership can open has to decide for it too, or the removal of an
// application reaches only the calls that spell the id out.
test("an application-access removal reaches a call that names no application", async () => {
  reset();
  const server = await connect("app.removal.no.app.id");
  try {
    // One organisation, one application: the call names the organisation only.
    const before = await createWebhookWithoutIds(server);
    evidence.push({ step: "One application, call names no ids", result: refused(before) ? "refused" : "allowed", posts: webhookPosts.length });
    assert.equal(refused(before), false, `the documented default must resolve the application, got: ${text(before)}`);
    assert.equal(webhookPosts.length, 1);

    // The Owner removes the application from the membership. The 60 s organisation map still holds
    // it, so only the live answer can tell — and the next call names nothing to be judged by.
    organization.accessibleApplications = [];
    const after = await createWebhookWithoutIds(server);
    const afterText = text(after);
    evidence.push({ step: "Application access removed, call names no ids", result: refused(after) ? "refused" : "allowed", posts: webhookPosts.length, text: afterText });
    assert.equal(refused(after), true, "the resolved default is judged by the live list too");
    assert.equal(webhookPosts.length, 1, "zero requests may reach the backend for an application the membership lost");
    assert.match(afterText, /does not include access to application/i, "the same plain refusal the named-application path gives");
    assert.match(afterText, new RegExp(APP), "and it names the application the call would have used");
  } finally {
    console.log(JSON.stringify({ finding: "default application", table: evidence, webhookPosts }, null, 2));
    server.close();
  }
});

// an internal issue finding 2: a call that resolves no organisation fans out over every organisation the
// 60 s map remembers. Each of those has to answer for itself, or a removal from one organisation
// keeps returning its rows.
test("a fan-out across organisations leaves out the one the person was removed from", async () => {
  reset();
  second.visible = true;
  const server = await connect("two.organizations.fan.out");
  try {
    // No ids at all: a member of two organisations gets both, newest first (here one row each).
    const before = await callTool(server, "didit_session_list", { limit: "5" });
    const beforeBody = JSON.parse(text(before));
    evidence.push({ step: "Two organisations, aggregate call", result: refused(before) ? "refused" : "allowed", orgs: sessionLists.map((l) => l.org) });
    assert.equal(refused(before), false, text(before));
    assert.deepEqual(new Set(sessionLists.map((l) => l.org)), new Set([ORG, ORG2]), "both organisations were read");
    assert.equal(beforeBody.results.length, 2);
    assert.equal(beforeBody.left_out_organizations, undefined, "nothing is left out while both are readable");

    // The Owner removes the member from the second organisation. The map still lists it.
    second.role = "absent";
    second.accessibleApplications = [];
    sessionLists.length = 0;
    const after = await callTool(server, "didit_session_list", { limit: "5" });
    const afterBody = JSON.parse(text(after));
    evidence.push({ step: "Removed from one of two, aggregate call", result: refused(after) ? "refused" : "allowed", orgs: sessionLists.map((l) => l.org), text: afterBody.left_out_note });
    assert.equal(refused(after), false, `the organisation the person still belongs to must answer, got: ${text(after)}`);
    assert.deepEqual(sessionLists.map((l) => l.org), [ORG], "no request may be made for the organisation left out");
    assert.equal(afterBody.results.length, 1, "only the organisation still readable contributes rows");
    assert.equal(afterBody.scanned_orgs, 1);
    assert.deepEqual(afterBody.left_out_organizations, [
      { organization_id: ORG2, organization_name: "Acme Two", reason: "you are no longer a member of it" },
    ]);
    assert.match(afterBody.left_out_note, /^Left out 1 organization: Acme Two \(you are no longer a member of it\); nothing was read from it\.$/, "one plain sentence, in the result");
  } finally {
    console.log(JSON.stringify({ finding: "cross-organisation fan-out", table: evidence }, null, 2));
    server.close();
  }
});

test("a fan-out whose every organisation is left out says so instead of reporting an empty account", async () => {
  reset();
  // Removed from both organisations, so no default scope resolves and the call fans out.
  organization.role = "absent";
  organization.accessibleApplications = [];
  second.visible = true;
  second.role = "absent";
  second.accessibleApplications = [];
  const server = await connect("every.organization.left.out");
  try {
    const answer = await callTool(server, "didit_session_search", { limit: "5" });
    const body = JSON.parse(text(answer));
    evidence.push({ step: "Removed from both organisations, aggregate call", result: refused(answer) ? "refused" : "allowed", orgs: sessionLists.map((l) => l.org), text: body.left_out_note });
    assert.equal(refused(answer), false, text(answer));
    assert.deepEqual(body.results, []);
    assert.deepEqual(sessionLists.map((l) => l.org), [], "nothing is read from an organisation the person is not in");
    assert.match(
      body.left_out_note,
      /^Left out 2 organizations: Acme \(you are no longer a member of it\), Acme Two \(you are no longer a member of it\); nothing was read from them\.$/,
    );
  } finally {
    console.log(JSON.stringify({ finding: "every organisation left out", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue finding 3: an answer that lists no permissions of its own must not refuse a tool that
// has no role check. Listing the applications of an organisation is the membership route: whatever
// the role grants, it needs no permission of its own.
test("a role the live answer lists no permissions for still reaches a tool with no role check", async () => {
  reset();
  organization.role = "removed";
  const server = await connect("no.permissions.membership.tool");
  try {
    const answer = await callTool(server, "didit_org_list_applications", { organization_id: ORG });
    const answerText = text(answer);
    evidence.push({ step: "Role lists no permissions, membership-level tool", result: refused(answer) ? "refused" : "allowed", text: answerText });
    assert.equal(refused(answer), false, `an empty permission list decides only tools that accept one, got: ${answerText}`);
    assert.match(answerText, /Primary/, "the applications the membership can open are answered");

    // The same answer still refuses a tool that DOES accept a permission.
    const refusedWrite = await callTool(server, "didit_webhook_create", { organization_id: ORG, label: "ops", url: "https://example.test/hook" });
    assert.equal(refused(refusedWrite), true);
    assert.match(text(refusedWrite), /membership/i);
  } finally {
    console.log(JSON.stringify({ finding: "empty permission list", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue finding 4: a GET is accepted for a role holding read:X OR list:X (core/permissions.py,
// _accepted_permissions). A custom role with only one of the two must not be refused.
test("a custom role holding only read:sessions lists sessions", async () => {
  reset();
  organization.role = "custom";
  const server = await connect("custom.role.read.sessions");
  try {
    const answer = await callTool(server, "didit_session_list", { organization_id: ORG, application_id: APP, limit: "5" });
    const answerText = text(answer);
    evidence.push({ step: "Custom role with read:sessions, list sessions", result: refused(answer) ? "refused" : "allowed", text: answerText.slice(0, 200) });
    assert.equal(refused(answer), false, `the console allows this call, so the MCP must too: ${answerText}`);
    assert.equal(sessionLists.length, 1, "the read reached the backend");
  } finally {
    console.log(JSON.stringify({ finding: "read:X or list:X", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue review: a fan-out that spans ORGANISATIONS must judge each one it is about to read.
// `didit_analytics` names no organization when the ids are omitted, so the dispatcher's check does
// not run for it: the 60 s map decided, and a removed organization kept being read and merged.
test("a cross-organization analytics fan-out leaves out the organization the person was removed from", async () => {
  reset();
  second.visible = true;
  const server = await connect("analytics.two.organizations");
  try {
    const before = await callTool(server, "didit_analytics", {});
    const beforeBody = JSON.parse(text(before));
    evidence.push({ step: "Two organisations, analytics", result: refused(before) ? "refused" : "allowed", orgs: analyticsRequests.map((r) => r.org) });
    assert.equal(refused(before), false, text(before));
    assert.deepEqual(new Set(analyticsRequests.map((r) => r.org)), new Set([ORG, ORG2]), "both organisations were read");
    assert.equal(beforeBody.scanned_apps, 2);
    assert.equal(beforeBody.left_out_organizations, undefined, "nothing is left out while both are readable");

    // The Owner removes the member from the second organisation; the map still lists it for 60 s.
    second.role = "absent";
    second.accessibleApplications = [];
    analyticsRequests.length = 0;
    const after = await callTool(server, "didit_analytics", {});
    const afterBody = JSON.parse(text(after));
    evidence.push({ step: "Removed from one of two, analytics", result: refused(after) ? "refused" : "allowed", orgs: analyticsRequests.map((r) => r.org), text: afterBody.left_out_note });
    assert.equal(refused(after), false, text(after));
    assert.deepEqual(analyticsRequests.map((r) => r.org), [ORG], "no request may be made for the organisation left out");
    assert.equal(afterBody.scanned_apps, 1);
    assert.equal(afterBody.request_breakdown.total_approved, 1, "only the readable organisation's rows are merged");
    assert.deepEqual(afterBody.left_out_organizations, [
      { organization_id: ORG2, organization_name: "Acme Two", reason: "you are no longer a member of it" },
    ]);
    assert.match(afterBody.left_out_note, /^Left out 1 organization: Acme Two \(you are no longer a member of it\); nothing was read from it\.$/, "a partial total is never presented as a whole one");
  } finally {
    console.log(JSON.stringify({ finding: "analytics fan-out across organisations", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue review: the same fan-out also spans APPLICATIONS. One organisation, two applications,
// the membership loses one — the 60 s map keeps it, so the live list of applications has to decide.
test("a cross-application fan-out stops reading an application the membership lost", async () => {
  reset();
  // Both applications are listed by the membership route (cached 60 s) and both are open at first.
  organization.apps = [
    { uuid: APP, name: "Primary" },
    { uuid: APP3, name: "Second" },
  ];
  organization.accessibleApplications = [APP, APP3];
  const server = await connect("two.applications.fan.out");
  try {
    const before = await callTool(server, "didit_vendor_user_search", { limit: "5" });
    const beforeBody = JSON.parse(text(before));
    evidence.push({ step: "Two applications, directory search", result: refused(before) ? "refused" : "allowed", apps: vendorUserLists.map((r) => r.app) });
    assert.equal(refused(before), false, text(before));
    assert.deepEqual(new Set(vendorUserLists.map((r) => r.app)), new Set([APP, APP3]), "both applications were read");
    assert.equal(beforeBody.left_out_applications, undefined);

    organization.accessibleApplications = [APP];
    vendorUserLists.length = 0;
    const after = await callTool(server, "didit_vendor_user_search", { limit: "5" });
    const afterBody = JSON.parse(text(after));
    evidence.push({ step: "Application access removed, directory search", result: refused(after) ? "refused" : "allowed", apps: vendorUserLists.map((r) => r.app), text: afterBody.left_out_note });
    assert.equal(refused(after), false, text(after));
    assert.deepEqual(vendorUserLists.map((r) => r.app), [APP], "no request may be made for the application left out");
    assert.equal(afterBody.results.length, 1, "only the application still open contributes rows");
    assert.equal(afterBody.scanned_apps, 1);
    assert.deepEqual(afterBody.left_out_applications, [
      {
        organization_id: ORG,
        organization_name: "Acme",
        application_id: APP3,
        application_name: "Second",
        reason: "does not include access to it",
      },
    ]);
    assert.match(afterBody.left_out_note, /^Left out 1 application: Second in Acme \(does not include access to it\); nothing was read from it\.$/, "the result says what it did not read");

    // The same state, with the organisation NAMED (the reviewer's other path): the result carries no
    // row of the application the membership lost, and that application's data is not fetched either.
    sessionListPaths.length = 0;
    const named = await callTool(server, "didit_session_search", { organization_id: ORG, limit: "5" });
    const namedBody = JSON.parse(text(named));
    evidence.push({ step: "Application access removed, named organisation", result: refused(named) ? "refused" : "allowed", paths: sessionListPaths.slice(), text: namedBody.left_out_note });
    assert.equal(refused(named), false, text(named));
    assert.deepEqual(namedBody.results.map((r) => r.application_id), [APP], "no row of the application left out is returned");
    assert.equal(namedBody.scanned_orgs, 1);
    assert.match(namedBody.left_out_note, /1 application: Second in Acme/, "the named-organisation call says what it left out too");
    // The organization-wide list would have answered for the lost application too (its rows then
    // dropped): "nothing was read from it" has to be true, so the call reads only the applications
    // the membership still opens.
    assert.deepEqual(
      sessionListPaths,
      [`https://api.example.test/v3/organization/${ORG}/application/${APP}/sessions/`],
      "no organization-wide read is made when the membership lost an application there",
    );

    // The analytics fan-out under a NAMED organisation is the same shape: it fans out over the
    // applications of that organisation, so the lost one must not be queried there either.
    analyticsRequests.length = 0;
    const namedAnalytics = await callTool(server, "didit_analytics", { organization_id: ORG });
    const namedAnalyticsBody = JSON.parse(text(namedAnalytics));
    evidence.push({ step: "Application access removed, named organisation analytics", result: refused(namedAnalytics) ? "refused" : "allowed", apps: analyticsRequests.map((r) => r.app) });
    assert.equal(refused(namedAnalytics), false, text(namedAnalytics));
    assert.deepEqual(analyticsRequests.map((r) => r.app), [APP], "no analytics request may be made for the application left out");
    assert.deepEqual(namedAnalyticsBody.left_out_applications.map((a) => a.application_id), [APP3]);
  } finally {
    console.log(JSON.stringify({ finding: "fan-out across applications", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue review: an organization-level tool that TAKES an application_id as a filter must not be
// judged on the resolved default application. The audit log belongs to the organization; its
// application_id only narrows which entries come back.
test("an organization-level tool is not refused for an application whose access was removed", async () => {
  reset();
  const server = await connect("audit.log.org.level");
  try {
    const before = await callTool(server, "didit_audit_log_list", { organization_id: ORG });
    assert.equal(refused(before), false, `an Admin reads the audit log, got: ${text(before)}`);
    assert.equal(auditLogLists.length, 1);

    organization.accessibleApplications = [];
    const after = await callTool(server, "didit_audit_log_list", { organization_id: ORG });
    const afterText = text(after);
    evidence.push({ step: "Application access removed, audit log", result: refused(after) ? "refused" : "allowed", requests: auditLogLists.length, text: afterText.slice(0, 200) });
    assert.equal(refused(after), false, `the audit log is not an application call, got: ${afterText}`);
    assert.equal(auditLogLists.length, 2, "the call reaches the organization-level route the backend serves");
    assert.doesNotMatch(afterText, /does not include access to application/, "a filter is not an application the call acts in");

    // The same state still refuses a tool that DOES act on one application.
    const webhook = await createWebhookWithoutIds(server);
    assert.equal(refused(webhook), true);
    assert.match(text(webhook), /does not include access to application/i);
  } finally {
    console.log(JSON.stringify({ finding: "organization-level tool with an application filter", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue review: a call that names an APPLICATION and no organization (a member of two
// organizations, naming one of their applications) still acts in that application. The dispatcher
// judged nothing for it, so a fan-out read both organizations and could answer with another
// application's row after the access to the named one was removed.
test("an application-access removal reaches a call that names the application and no organization", async () => {
  reset();
  second.visible = true;
  const server = await connect("application.only.two.organizations");
  try {
    // The named application only: its own organization answers, the other one does not.
    const before = await callTool(server, "didit_vendor_user_search", { application_id: APP, limit: "5" });
    const beforeBody = JSON.parse(text(before));
    evidence.push({ step: "Named application, no organization", result: refused(before) ? "refused" : "allowed", apps: vendorUserLists.map((r) => r.app) });
    assert.equal(refused(before), false, text(before));
    assert.deepEqual(vendorUserLists.map((r) => `${r.org}/${r.app}`), [`${ORG}/${APP}`], "only the application the call acts on is read");
    assert.deepEqual(beforeBody.results.map((r) => r.vendor_data), [`customer-of-2222`], "no other application's row stands in for the one asked for");

    // The same through the organization-wide route: naming only the application must not read
    // another organization's sessions.
    sessionListPaths.length = 0;
    const namedSearch = await callTool(server, "didit_session_search", { application_id: APP, limit: "5" });
    evidence.push({ step: "Named application, session search", result: refused(namedSearch) ? "refused" : "allowed", paths: sessionListPaths.slice() });
    assert.equal(refused(namedSearch), false, text(namedSearch));
    assert.deepEqual(
      sessionListPaths,
      [`https://api.example.test/v3/organization/${ORG}/application/${APP}/sessions/`],
      "the fan-out is cut to the application the call acts on",
    );
    assert.doesNotMatch(text(namedSearch), /session-77777777/, "the second organization's application contributes no row");

    // Analytics fans out per application; the same named application must not merge the other
    // organization's numbers (the review named this fan-out too).
    analyticsRequests.length = 0;
    const namedAnalytics = await callTool(server, "didit_analytics", { application_id: APP });
    const namedAnalyticsBody = JSON.parse(text(namedAnalytics));
    evidence.push({ step: "Named application, analytics", result: refused(namedAnalytics) ? "refused" : "allowed", apps: analyticsRequests.map((r) => r.app) });
    assert.equal(refused(namedAnalytics), false, text(namedAnalytics));
    assert.deepEqual(analyticsRequests.map((r) => `${r.org}/${r.app}`), [`${ORG}/${APP}`], "analytics reads only the named application");
    assert.equal(namedAnalyticsBody.scanned_apps, 1);

    // The Owner removes the application from the membership. The map still lists it for 60 s.
    organization.accessibleApplications = [];
    vendorUserLists.length = 0;
    sessionListPaths.length = 0;
    const after = await callTool(server, "didit_vendor_user_search", { application_id: APP, limit: "5" });
    const afterText = text(after);
    evidence.push({ step: "Application access removed, named application only", result: refused(after) ? "refused" : "allowed", apps: vendorUserLists.map((r) => r.app), text: afterText });
    assert.equal(refused(after), true, `the live membership decides a call that names only an application, got: ${afterText}`);
    assert.deepEqual(vendorUserLists, [], "zero requests may reach the backend for an application the membership lost");
    assert.match(afterText, /does not include access to application/i, "the same plain refusal the named-organization path gives");
    assert.match(afterText, new RegExp(APP), "and it names the application");

    const afterSearch = await callTool(server, "didit_session_search", { application_id: APP, limit: "5" });
    assert.equal(refused(afterSearch), true, "the search tool is refused too");
    assert.deepEqual(sessionListPaths, [], "and reads nothing at all");

    analyticsRequests.length = 0;
    const afterAnalytics = await callTool(server, "didit_analytics", { application_id: APP });
    assert.equal(refused(afterAnalytics), true, "the analytics fan-out is refused too");
    assert.deepEqual(analyticsRequests, [], "and reads no application's analytics");
  } finally {
    console.log(JSON.stringify({ finding: "named application without an organization", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue review: a fan-out leaves an organization out for want of the permission its tool needs.
// That answer cannot see whether the role ever held it, so the result must not say a change happened.
test("a fan-out left out for want of a permission claims no change", async () => {
  reset();
  second.visible = true;
  organization.role = "reader"; // the Reader role lists no read:users, and never had it here
  const server = await connect("left.out.for.permission");
  try {
    const answer = await callTool(server, "didit_vendor_user_search", { limit: "5" });
    const body = JSON.parse(text(answer));
    evidence.push({ step: "Reader over two organizations, directory search", result: refused(answer) ? "refused" : "allowed", text: body.left_out_note });
    assert.equal(refused(answer), false, text(answer));
    assert.deepEqual(vendorUserLists.map((r) => r.org), [ORG2], "only the readable organization is queried");
    assert.deepEqual(body.left_out_organizations, [
      { organization_id: ORG, organization_name: "Acme", reason: "your role there does not include the permission it needs" },
    ]);
    assert.doesNotMatch(body.left_out_note, /no longer/, "the live answer cannot see a change, so none is claimed");
  } finally {
    console.log(JSON.stringify({ finding: "left out for want of a permission", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue review: the live answer is asked about the APPLICATION the call will read, not every
// application of the organization. A removed sibling must not appear in `left_out_applications`,
// because this call never reads it.
test("a call naming only an application does not report a sibling application it never reads", async () => {
  reset();
  second.visible = true;
  organization.apps = [
    { uuid: APP, name: "Primary" },
    { uuid: APP3, name: "Sibling" },
  ];
  organization.accessibleApplications = [APP];
  const server = await connect("named.application.only");
  try {
    const answer = await callTool(server, "didit_vendor_user_search", { application_id: APP, limit: "5" });
    assert.equal(refused(answer), false, text(answer));
    const body = JSON.parse(text(answer));
    assert.deepEqual(liveQuestions, [ORG], "one question, for the organization that lists the application");
    assert.equal(body.left_out_applications, undefined, "the removed sibling is not named: this call never reads it");
    assert.equal(body.left_out_note, undefined, "nothing was left out of what this call reads");
    assert.deepEqual(vendorUserLists.map((r) => `${r.org}/${r.app}`), [`${ORG}/${APP}`], "only the named application is read");
  } finally {
    server.close();
  }
});

// an internal issue review: a two-organization member who names only an application acts in that
// application's organization. The live membership is asked once, not once per organization, and an
// unrelated organization's failure cannot fail the call.
test("a call naming only an application asks one live membership question", async () => {
  reset();
  second.visible = true;
  const server = await connect("one.live.question.per.application");
  try {
    const directory = await callTool(server, "didit_vendor_user_search", { application_id: APP, limit: "5" });
    evidence.push({ step: "Named application, directory search", result: refused(directory) ? "refused" : "allowed", questions: liveQuestions.slice(), apps: vendorUserLists.map((r) => `${r.org}/${r.app}`) });
    assert.equal(refused(directory), false, text(directory));
    assert.deepEqual(liveQuestions, [ORG], "one question, for the organization that lists the application");
    assert.deepEqual(vendorUserLists.map((r) => `${r.org}/${r.app}`), [`${ORG}/${APP}`], "the other organization's application is not read");

    liveQuestions.length = 0;
    const sessions = await callTool(server, "didit_session_search", { application_id: APP, limit: "5" });
    evidence.push({ step: "Named application, session search", result: refused(sessions) ? "refused" : "allowed", questions: liveQuestions.slice(), paths: sessionListPaths.slice() });
    assert.equal(refused(sessions), false, text(sessions));
    assert.deepEqual(liveQuestions, [ORG], "still one question");
    assert.deepEqual(
      sessionListPaths,
      [`https://api.example.test/v3/organization/${ORG}/application/${APP}/sessions/`],
      "the session read is cut to the named application",
    );

    liveQuestions.length = 0;
    vendorUserLists.length = 0;
    const analytics = await callTool(server, "didit_analytics", { application_id: APP });
    evidence.push({ step: "Named application, analytics", result: refused(analytics) ? "refused" : "allowed", questions: liveQuestions.slice(), apps: analyticsRequests.map((r) => `${r.org}/${r.app}`) });
    assert.equal(refused(analytics), false, text(analytics));
    assert.deepEqual(liveQuestions, [ORG], "still one question");
    assert.deepEqual(analyticsRequests.map((r) => `${r.org}/${r.app}`), [`${ORG}/${APP}`], "analytics reads only the named application");
  } finally {
    console.log(JSON.stringify({ finding: "one live question for a named application", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue review: `org_permissions` may arrive as a space-delimited string (RFC 7662 scope
// values), the shape the token verifier already accepts. Reading only the array left `permissions`
// undefined, so every permission test skipped and a demotion was forwarded to the backend — which
// answered from its own 600 s copy. The refusal has to come from the live answer instead.
test("a live answer listing permissions as a space-delimited string still refuses a demotion", async () => {
  reset();
  organization.permissionsShape = "string";
  const server = await connect("string.permissions");
  try {
    const asAdmin = await createWebhook(server);
    evidence.push({ step: "Admin, permissions as a string", result: refused(asAdmin) ? "refused" : "allowed", posts: webhookPosts.length });
    assert.equal(refused(asAdmin), false, `an Admin call must be allowed, got: ${text(asAdmin)}`);
    assert.equal(webhookPosts.length, 1);

    organization.role = "reader";
    const demoted = await createWebhook(server);
    const demotedText = text(demoted);
    evidence.push({ step: "Reader, permissions as a string", result: refused(demoted) ? "refused" : "allowed", posts: webhookPosts.length, text: demotedText });
    assert.equal(refused(demoted), true, "the string shape decides exactly like the array shape");
    assert.equal(webhookPosts.length, 1, "nothing may be forwarded, so the backend's cached answer is never asked");
    assert.match(demotedText, /write:webhooks/, "the refusal names the permission the current role lacks");
  } finally {
    console.log(JSON.stringify({ finding: "space-delimited org_permissions", table: evidence }, null, 2));
    server.close();
  }
});

// an internal issue review, documented bound: `didit_session_get_decision`, `didit_session_update_status`
// and `didit_session_delete` take only a session id (the flat `/session/{id}/…` routes), so a member
// of several organizations names none. No single organization resolves there, so the server has no
// membership to ask about and the verification service alone decides these calls, from its own copy
// of the role (up to 600 s). That bound is stated in the README's bounds list; this test pins it so
// it cannot change unnoticed.
test("a session-id-only call asks no live question, so a change reaches it within the verification service's 600 s bound", async () => {
  reset();
  second.visible = true;
  const SESSION_ID = "99999999-9999-4999-8999-999999999999";
  const server = await connect("session.id.only.two.organizations");
  try {
    // Admin: every one of the three calls reaches the backend, and the server asks nothing.
    for (const [name, args] of [
      ["didit_session_get_decision", { session_id: SESSION_ID }],
      ["didit_session_update_status", { session_id: SESSION_ID, new_status: "Approved" }],
      ["didit_session_delete", { session_id: SESSION_ID, confirm: true }],
    ]) {
      const answer = await callTool(server, name, args);
      evidence.push({ step: `${name} as Admin`, result: refused(answer) ? "refused" : "allowed", bound: "n/a" });
      assert.equal(refused(answer), false, `${name} must reach the backend as an Admin, got: ${text(answer)}`);
    }
    assert.equal(sessionOnlyCalls.length, 3, "each call reached its flat endpoint");
    assert.deepEqual(liveQuestions, [], "no organization is named, so there is no membership the server could ask about");

    // The Owner removes the member. The verification service still holds the Admin answer it cached
    // for this session's organization, and it is the only judge here: the old rights last until that
    // copy expires. This is the bound the README states, not something the server can shorten.
    organization.role = "removed";
    const withinBound = await callTool(server, "didit_session_get_decision", { session_id: SESSION_ID });
    evidence.push({ step: "Removed, inside the 600 s bound", result: refused(withinBound) ? "refused" : "allowed", questions: liveQuestions.length });
    assert.equal(refused(withinBound), false, "inside its own copy's lifetime the verification service still answers for the old role");
    assert.deepEqual(liveQuestions, [], "still nothing the server could ask");

    // Once that copy expires the same connection is refused, with no reconnect.
    backendCache.clear();
    const afterBound = await callTool(server, "didit_session_get_decision", { session_id: SESSION_ID });
    evidence.push({ step: "Removed, after the 600 s bound", result: refused(afterBound) ? "refused" : "allowed" });
    assert.equal(refused(afterBound), true, "the removal reaches the call when the verification service's copy expires");
    assert.match(text(afterBound), /permission/i, "the refusal is the verification service's own");
  } finally {
    console.log(JSON.stringify({ finding: "session-id-only calls and their documented bound", table: evidence }, null, 2));
    server.close();
  }
});
