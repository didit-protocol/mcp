import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";

// Several tools sent whatever they were given to the API and declared nothing: "Add an entry to
// the blocklist" and "Create a case." had no argument at all. A model cannot call what it is not
// told how to call. In a tool-selection eval no model called either one directly; all of them
// went looking the session or the user up instead.
//
// Each tool below now declares what its endpoint accepts, and refuses, before anything is sent,
// the one mistake its shape invites.

for (const name of ["DIDIT_ACCESS_TOKEN", "DIDIT_IS_STAFF", "MCP_DEFAULT_TOOLSETS", "MCP_PERMISSION_MODE"]) delete process.env[name];

const APP_BASE = "https://verification.didit.me/v3/organization/org-1/application/app-1";
const SCOPE = { organization_id: "org-1", application_id: "app-1" };
const SESSION = "3f2a9c1e-7b4d-4e8a-9c53-1d2e6f7a8b90";
const PERSON = { token: "person.access.token", clientId: "tool-arguments-test", scopes: [], extra: { organization_id: "org-1" } };

function backend() {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  return { seen, restore: () => (globalThis.fetch = original) };
}

async function withClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo: PERSON });
  const client = new Client({ name: "tool-arguments-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (result) => result.content.map((item) => item.text).join("\n");
/** A tool's own arguments: everything but the two routing ids. */
const own = (tool) => Object.keys(tool.inputSchema.properties ?? {}).filter((key) => key !== "organization_id" && key !== "application_id");

test("the tools say what they take", async () => {
  await withClient(async (client) => {
    const byName = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const expected = {
      didit_blocklist_get: ["item_type", "limit", "offset"],
      didit_blocklist_add: ["session_id", "blocklist_face", "blocklist_document", "blocklist_phone", "blocklist_email"],
      didit_blocklist_remove: ["session_id", "unblock_face", "unblock_document", "unblock_phone", "unblock_email"],
      didit_allowlist_add: ["session_id", "allowlist_phone"],
      didit_case_create: ["title", "subject", "links", "priority", "assigned_to", "due_at", "tags", "blueprint", "review_duplicates", "separate_incident_reason"],
      didit_case_statistics: ["date_from", "date_to", "status", "priority", "source", "scope", "assigned_to", "blueprint"],
      didit_alert_configure: ["alert_type", "data"],
    };
    for (const [name, args] of Object.entries(expected)) {
      const tool = byName.get(name);
      assert.deepEqual(own(tool), args, name);
      for (const key of args) {
        const property = tool.inputSchema.properties[key];
        assert.ok(property.description || property.enum, `${name}.${key} is described or enumerated`);
      }
    }
    assert.deepEqual(byName.get("didit_blocklist_add").inputSchema.required, ["session_id"]);
    assert.deepEqual(byName.get("didit_allowlist_add").inputSchema.required, ["session_id", "allowlist_phone"]);
    assert.deepEqual(byName.get("didit_case_create").inputSchema.required, ["title"]);
    assert.deepEqual(byName.get("didit_blocklist_get").inputSchema.properties.item_type.enum, ["face", "document", "phone", "email"]);

    const createCase = byName.get("didit_case_create").inputSchema.properties;
    assert.deepEqual(createCase.subject.properties.type.enum, ["user", "business"]);
    assert.deepEqual(createCase.subject.required, ["type", "uuid"]);
    assert.deepEqual(createCase.links.items.properties.entity_type.enum, ["session", "business_session", "transaction"]);
    assert.deepEqual(createCase.priority.enum, ["LOW", "MEDIUM", "HIGH"]);
    // The id of a subject is the easy thing to get wrong: the description says which one it is.
    assert.match(byName.get("didit_case_create").description, /`didit_internal_id`.*not their vendor_data/);
    assert.match(createCase.subject.properties.uuid.description, /didit_internal_id/);

    const alert = byName.get("didit_alert_configure").inputSchema.properties;
    assert.deepEqual(alert.alert_type.enum, ["email", "slack"]);
    assert.deepEqual(Object.keys(alert.data.properties), ["value", "is_active"]);

    // The id that removes a member is the one field of the members list a model would not guess.
    const member = byName.get("didit_org_remove_member");
    assert.match(member.inputSchema.properties.member_id.description, /`uuid`.*didit_org_list_members/);
    assert.match(member.inputSchema.properties.member_id.description, /Not `user_id`/);
    assert.match(member.description, /cannot be undone/);
  });
});

test("a blocklist or allowlist call that names no item is refused before anything is sent", async () => {
  const api = backend();
  try {
    await withClient(async (client) => {
      const call = (name, args) => client.callTool({ name, arguments: { ...SCOPE, ...args } });
      const refusals = [
        ["didit_blocklist_add", { session_id: SESSION }, /at least one of blocklist_face, blocklist_document, blocklist_phone, blocklist_email/],
        ["didit_blocklist_add", { session_id: SESSION, blocklist_face: false, blocklist_email: "yes" }, /Say what to block/],
        ["didit_blocklist_remove", { session_id: SESSION }, /at least one of unblock_face/],
        ["didit_allowlist_add", { session_id: SESSION }, /set allowlist_phone to true/],
        ["didit_allowlist_add", { session_id: SESSION, allowlist_phone: false }, /Say what to allowlist/],
      ];
      for (const [name, args, message] of refusals) {
        const result = await call(name, args);
        assert.equal(result.isError, true, `${name} accepted ${JSON.stringify(args)}`);
        assert.match(textOf(result), /Error \[bad_request\]/);
        assert.match(textOf(result), message);
      }
      assert.equal(api.seen.length, 0);

      await call("didit_blocklist_add", { session_id: SESSION, blocklist_face: true, blocklist_document: true });
      assert.deepEqual(api.seen.at(-1), { url: `${APP_BASE}/blocklist/add/`, method: "POST", body: { session_id: SESSION, blocklist_face: true, blocklist_document: true } });
      await call("didit_blocklist_remove", { session_id: SESSION, unblock_phone: true });
      assert.deepEqual(api.seen.at(-1), { url: `${APP_BASE}/blocklist/remove/`, method: "POST", body: { session_id: SESSION, unblock_phone: true } });
      await call("didit_allowlist_add", { session_id: SESSION, allowlist_phone: true });
      assert.deepEqual(api.seen.at(-1), { url: `${APP_BASE}/allowlist/add/`, method: "POST", body: { session_id: SESSION, allowlist_phone: true } });
    });
  } finally {
    api.restore();
  }
});

test("a case needs a subject or a link, and what is sent is what was given", async () => {
  const api = backend();
  try {
    await withClient(async (client) => {
      const call = (args) => client.callTool({ name: "didit_case_create", arguments: { ...SCOPE, ...args } });
      for (const nothing of [{ title: "Suspected mule account" }, { title: "x", links: [] }, { title: "x", subject: "user-8841" }]) {
        const refused = await call(nothing);
        assert.equal(refused.isError, true, `accepted ${JSON.stringify(nothing)}`);
        assert.match(textOf(refused), /A case needs a subject or at least one link/);
        assert.match(textOf(refused), /didit_vendor_user_get/);
      }
      assert.equal(api.seen.length, 0);

      const aboutSomeone = { title: "Suspected mule account", subject: { type: "user", uuid: "0b6f5d7c-1a2b-4c3d-9e8f-7a6b5c4d3e2f" }, priority: "HIGH", tags: ["mule"] };
      await call(aboutSomeone);
      assert.deepEqual(api.seen.at(-1), { url: `${APP_BASE}/cases/`, method: "POST", body: aboutSomeone });
      const aboutSomething = { title: "Structuring", links: [{ entity_type: "transaction", entity_uuid: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d" }] };
      await call(aboutSomething);
      assert.deepEqual(api.seen.at(-1).body, aboutSomething);
    });
  } finally {
    api.restore();
  }
});

test("the read tools send their filters, and the blocklist its page", async () => {
  const api = backend();
  try {
    await withClient(async (client) => {
      const call = (name, args) => client.callTool({ name, arguments: { ...SCOPE, ...args } });
      await call("didit_blocklist_get", { item_type: "face", limit: 10, offset: 20 });
      assert.equal(api.seen.at(-1).url, `${APP_BASE}/blocklist/?item_type=face&limit=10&offset=20`);
      const refused = await call("didit_blocklist_get", { limit: 5000 });
      assert.equal(refused.isError, true);

      await call("didit_case_statistics", { date_from: "2026-10-01", date_to: "2026-10-31", status: "OPEN", scope: "transactions" });
      assert.equal(api.seen.at(-1).url, `${APP_BASE}/cases/statistics/?date_from=2026-10-01&date_to=2026-10-31&status=OPEN&scope=transactions`);

      await call("didit_alert_configure", { alert_type: "email", data: { value: "compliance@acme.example", is_active: true } });
      assert.deepEqual(api.seen.at(-1), { url: `${APP_BASE}/alerts/email/`, method: "PATCH", body: { value: "compliance@acme.example", is_active: true } });
    });
  } finally {
    api.restore();
  }
});
