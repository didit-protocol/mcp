import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// an internal issue (root cause of an internal issue): an organization Admin could not invite a member
// ("Method POST not allowed" -> 405) or change a member's role (404). The org-member
// tools in src/tools/members.ts call routes service-didit-auth does not publish and send
// payloads its serializers reject.
//
// This test stands in for service-didit-auth with the exact route table and serializer
// contract from that repo, so a call only succeeds if BOTH the route and the body match:
//
//   organizations/urls.py
//     GET    /organizations/<org>/members/            members-list (GET only)
//     POST   /organizations/<org>/members/invite/     members-invite
//     PATCH  /organizations/<org>/members/<member>    members-retrieve-update-destroy (NO trailing slash)
//     DELETE /organizations/<org>/members/<member>    members-retrieve-update-destroy (NO trailing slash)
//
//   serializers/member.py
//     InviteMemberSerializer:            emails (list, 1-5), role (uuid), app_ids (list of uuids)
//     OrganizationMemberUpdateSerializer: role (uuid), accessible_applications (list of uuids)
//
// fe-application-console (src/modules/settings/services/members-client.ts) is the reference
// client and already posts { emails, app_ids, role } and patches { role, accessible_applications }.

const ORG = "11111111-1111-1111-1111-111111111111";
const MEMBER = "22222222-2222-2222-2222-222222222222";
const ROLE = "33333333-3333-3333-3333-333333333333";
const APP = "44444444-4444-4444-4444-444444444444";
const EMAIL = "invitee@example.com";

const UUID = "[0-9a-fA-F-]{36}";

// Django URL resolution, restricted to the routes the member tools touch (plus the
// scope-discovery reads ensureScopeDefaults makes first).
const ROUTES = [
  { re: /^\/organizations\/me\/$/, methods: ["GET"], body: [{ uuid: ORG, name: "Acme" }] },
  { re: new RegExp(`^/organizations/me/${UUID}/applications/$`), methods: ["GET"], body: [{ uuid: APP, name: "App" }] },
  { re: new RegExp(`^/organizations/${UUID}/members/$`), methods: ["GET"], body: [] },
  { re: new RegExp(`^/organizations/${UUID}/members/pending/$`), methods: ["GET"], body: [] },
  { re: new RegExp(`^/organizations/${UUID}/members/invite/$`), methods: ["POST"], body: { detail: "Invitations sent." } },
  { re: new RegExp(`^/organizations/${UUID}/members/${UUID}$`), methods: ["GET", "PATCH", "DELETE"] },
  { re: new RegExp(`^/organizations/${UUID}/roles/$`), methods: ["GET"], body: [] },
];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Emulates service-didit-auth: route resolution returns 405 when the path exists for
 * another method and 404 when it does not exist (APPEND_SLASH never strips a slash), and
 * the serializers reject a body that is missing a required field.
 */
function stubAuthService() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const { pathname } = new URL(String(url));
    const path = pathname.replace(/^\/auth\/v2/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, url: String(url) });

    const route = ROUTES.find((r) => r.re.test(path));
    if (!route) return json({ detail: "Not found." }, 404);
    if (!route.methods.includes(method)) {
      return json({ detail: `Method "${method}" not allowed.` }, 405);
    }

    if (method === "POST" && /\/members\/invite\/$/.test(path)) {
      const errors = {};
      if (!Array.isArray(body?.emails) || body.emails.length < 1 || body.emails.length > 5) {
        errors.emails = ["This field is required."];
      }
      if (typeof body?.role !== "string") errors.role = ["This field is required."];
      if (!Array.isArray(body?.app_ids)) errors.app_ids = ["This field is required."];
      if (Object.keys(errors).length) return json(errors, 400);
      return json({ detail: "Invitations sent." }, 201);
    }

    if (method === "PATCH") {
      const errors = {};
      if (typeof body?.role !== "string") errors.role = ["This field is required."];
      if (!Array.isArray(body?.accessible_applications)) {
        errors.accessible_applications = ["This field is required."];
      }
      if (Object.keys(errors).length) return json(errors, 400);
      return new Response(null, { status: 204 });
    }

    if (method === "DELETE") return new Response(null, { status: 204 });
    return json(route.body ?? []);
  };
  return calls;
}

const textOf = (res) => (res.content || []).map((c) => c.text).join("\n");

async function callTool(name, args) {
  const authInfo = {
    token: "tok-members",
    clientId: "client-1",
    scopes: [],
    extra: { sub: "user-1", organization_id: ORG },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo });
  const client = new Client({ name: "member-tools-routes-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

test("didit_org_invite_member POSTs the invite route with the InviteMemberSerializer payload", async () => {
  const calls = stubAuthService();
  const res = await callTool("didit_org_invite_member", {
    organization_id: ORG,
    emails: [EMAIL],
    role: ROLE,
    app_ids: [APP],
  });

  const req = calls.at(-1);
  assert.equal(req?.method, "POST");
  assert.equal(req?.path, `/organizations/${ORG}/members/invite/`, `wrong route: ${req?.method} ${req?.path}`);
  assert.deepEqual(req?.body, { emails: [EMAIL], role: ROLE, app_ids: [APP] });
  assert.equal(res.isError, undefined, textOf(res));
});

test("didit_org_update_member PATCHes the detail route (no trailing slash) with role + accessible_applications", async () => {
  const calls = stubAuthService();
  const res = await callTool("didit_org_update_member", {
    organization_id: ORG,
    member_id: MEMBER,
    role: ROLE,
    accessible_applications: [APP],
  });

  const req = calls.at(-1);
  assert.equal(req?.method, "PATCH");
  assert.equal(req?.path, `/organizations/${ORG}/members/${MEMBER}`, `wrong route: ${req?.method} ${req?.path}`);
  assert.deepEqual(req?.body, { role: ROLE, accessible_applications: [APP] });
  assert.equal(res.isError, undefined, textOf(res));
});

test("didit_org_remove_member DELETEs the detail route (no trailing slash)", async () => {
  const calls = stubAuthService();
  const res = await callTool("didit_org_remove_member", {
    organization_id: ORG,
    member_id: MEMBER,
  });

  const req = calls.at(-1);
  assert.equal(req?.method, "DELETE");
  assert.equal(req?.path, `/organizations/${ORG}/members/${MEMBER}`, `wrong route: ${req?.method} ${req?.path}`);
  assert.equal(res.isError, undefined, textOf(res));
});
