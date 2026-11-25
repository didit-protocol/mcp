import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";
import { toolGroupOf, toolsetOf } from "../dist/toolsets.js";

// The Messages reads against the console routes of the verification service (messages/urls.py), and
// the two reads of what the organization pays for (plans/urls.py). Nothing here sends a message.

for (const name of ["DIDIT_ACCESS_TOKEN", "MCP_PERMISSION_MODE", "DIDIT_TOOLSETS", "MCP_DEFAULT_ORG", "MCP_DEFAULT_APP"]) delete process.env[name];

const API = "https://verification.didit.me/v3";
const ORG = "0d6b5c1e-2f3a-4b7c-8d9e-1a2b3c4d5e6f";
const APP = "a1b2c3d4-0000-4000-8000-000000000002";
const CONVERSATION = "5e55aaaa-2222-4333-8444-555555555555";
const SCOPE = { organization_id: ORG, application_id: APP };
const MESSAGES = `/organization/${ORG}/application/${APP}/messages`;
const PERSON = { token: "messages.person.token", clientId: "messages-test", scopes: [], extra: { organization_id: ORG } };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const textOf = (result) => result.content.map((block) => block.text).join("\n");

async function withApi(reply, fn) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (!target.startsWith(API)) return json([]);
    sent.push(`${init.method ?? "GET"} ${target.slice(API.length)}`);

    return reply(target);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo: PERSON });
  const client = new Client({ name: "messages-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn({ sent, client, call: (name, args) => client.callTool({ name, arguments: args }) });
  } finally {
    globalThis.fetch = original;
    await client.close();
    await server.close();
  }
}

test("conversations, a thread, templates and channels are read from the console routes", async () => {
  await withApi(() => json({ results: [] }), async ({ sent, call }) => {
    await call("didit_message_conversation_list", { ...SCOPE, search: "S-12", tab: "needs_reply", channel: "whatsapp", event: "retry", limit: 10, offset: 5 });
    await call("didit_message_conversation_get", { ...SCOPE, conversation_id: CONVERSATION });
    await call("didit_message_conversation_get", { ...SCOPE, session_id: CONVERSATION });
    await call("didit_message_template_list", { ...SCOPE, channel: "sms" });
    const result = await call("didit_message_template_list", { ...SCOPE, include_channels: true });

    assert.deepEqual(JSON.parse(textOf(result)), { results: [], channels: { results: [] } });
    assert.deepEqual(sent, [
      `GET ${MESSAGES}/conversations/?q=S-12&tab=needs_reply&channel=whatsapp&event=retry&limit=10&offset=5`,
      `GET ${MESSAGES}/conversations/${CONVERSATION}/`,
      `GET ${MESSAGES}/sessions/${CONVERSATION}/messages/`,
      `GET ${MESSAGES}/templates/?channel=sms`,
      `GET ${MESSAGES}/templates/`,
      `GET ${MESSAGES}/channels/`,
    ]);
  });
});

test("a thread needs exactly one reference, and a role without the permission is told", async () => {
  await withApi(() => json({ detail: "You do not have permission to perform this action." }, 403), async ({ sent, call }) => {
    for (const args of [{}, { conversation_id: CONVERSATION, session_id: CONVERSATION }]) {
      const refused = await call("didit_message_conversation_get", { ...SCOPE, ...args });
      assert.equal(refused.isError, true);
      assert.match(textOf(refused), /exactly one/);
    }
    assert.deepEqual(sent, []);
    const forbidden = await call("didit_message_conversation_list", SCOPE);
    assert.equal(forbidden.isError, true);
    assert.match(textOf(forbidden), /forbidden/);
  });
});

test("the message tools only read, under the permissions their views accept", async () => {
  const permissions = {
    didit_message_conversation_list: ["list:messages", "list:sessions"],
    didit_message_conversation_get: ["read:messages", "read:sessions"],
    didit_message_template_list: ["list:messages", "list:sessions"],
  };
  await withApi(() => json({}), async ({ client }) => {
    const { tools } = await client.listTools();
    for (const [name, accepted] of Object.entries(permissions)) {
      assert.deepEqual(TOOL_PERMISSIONS[name], accepted);
      assert.equal(tools.find((tool) => tool.name === name).annotations.readOnlyHint, true);
      assert.equal(toolsetOf(name), "messages");
      assert.equal(toolGroupOf(name), "Messages");
    }
  });
});

test("the plan's entitlements and the public list prices are read where they live", async () => {
  await withApi(() => json({ plan: "growth" }), async ({ sent, call }) => {
    await call("didit_org_entitlements_get", { organization_id: ORG });
    await call("didit_price_book_get", {});
    assert.deepEqual(sent, [`GET /organization/${ORG}/plan-entitlements/`, "GET /organization/price-book/"]);
  });
  assert.equal(TOOL_PERMISSIONS.didit_org_entitlements_get, "read:organization");
  assert.equal(TOOL_PERMISSIONS.didit_price_book_get, null);
  assert.equal(toolsetOf("didit_price_book_get"), "billing");
  await withApi(() => json({ detail: "You do not have permission to perform this action." }, 403), async ({ call }) => {
    assert.equal((await call("didit_org_entitlements_get", { organization_id: ORG })).isError, true);
  });
});
