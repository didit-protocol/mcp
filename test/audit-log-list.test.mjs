import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";

// didit_audit_log_list reads the organization's audit log at /audit/{org}/audit-logs/ on the
// verification API (the app-scoped /organization/{org}/application/{app}/audit-logs/ it used
// to call does not exist), maps its arguments onto the backend's list filters, and hands the
// entries back whole: actor, action, description, target and changes.investigator are what
// "who approved session N" and "what did the Investigator decide on its own" are answered from.

const API = "https://verification.didit.me/v3";
const ORG = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";

const PAGE = {
  count: 1,
  next: null,
  previous: null,
  window_start: null,
  results: [
    {
      event_id: "evt_1",
      actor: { type: "investigator", name: "Investigator", email: null, user_id: null, role: null, api_key: null },
      action: "session.approved",
      action_category: "sessions",
      description: "approved session 20458",
      target: { type: "session", id: SESSION, label: "20458" },
      application_id: APP,
      application_name: "Main",
      created_at: "2026-10-29T10:00:00Z",
      changes: {
        status: "Approved",
        previous_status: "In Review",
        investigator: {
          run_id: RUN,
          outcome: "automated",
          recommendation: "approve",
          confidence: 0.93,
          agreed: true,
          policy: { tier: "auto", rule: "low-risk approvals", policy_version: 3 },
        },
      },
    },
  ],
};

delete process.env.DIDIT_ACCESS_TOKEN;

function stubFetch() {
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push({ url: new URL(String(url)) });

    return new Response(JSON.stringify(PAGE), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  return calls;
}

async function withClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "audit-log-list-test", version: "1.0.0" }, { capabilities: {} });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const callAuditLogList = (args) => withClient((client) => client.callTool({ name: "didit_audit_log_list", arguments: args }));

test("the audit log is the organization's /audit/{org}/audit-logs/, guarded by read:audit-logs", () => {
  assert.equal(TOOL_PERMISSIONS.didit_audit_log_list, "read:audit-logs");
});

test("every argument maps onto the backend's list filter of the same name", async () => {
  const calls = stubFetch();
  const filters = {
    actor_type: "investigator",
    action_category: "sessions",
    target_type: "session",
    target_id: SESSION,
    search: "20458",
    created_at_start: "2026-10-01T00:00:00Z",
    created_at_end: "2026-10-29T23:59:59Z",
    page: 2,
    page_size: 50,
  };

  const res = await callAuditLogList({ organization_id: ORG, application_id: APP, ...filters });

  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.equal(calls.length, 1);
  assert.equal(`${calls[0].url.origin}${calls[0].url.pathname}`, `${API}/audit/${ORG}/audit-logs/`);
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
    application_id: APP,
    ...Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, String(value)])),
  });
});

test("without application_id the whole organization is listed, even with a default application", async () => {
  const calls = stubFetch();
  const previousApp = process.env.MCP_DEFAULT_APP;

  process.env.MCP_DEFAULT_APP = APP;
  try {
    await callAuditLogList({ organization_id: ORG });
  } finally {
    if (previousApp === undefined) delete process.env.MCP_DEFAULT_APP;
    else process.env.MCP_DEFAULT_APP = previousApp;
  }

  assert.equal(calls[0].url.pathname, `/v3/audit/${ORG}/audit-logs/`);
  assert.deepEqual([...calls[0].url.searchParams.keys()], []);
});

test("entries come back whole: actor, description, target, action and changes.investigator", async () => {
  stubFetch();

  const res = await callAuditLogList({ organization_id: ORG, actor_type: "investigator" });

  assert.deepEqual(res.structuredContent, PAGE);
  assert.deepEqual(JSON.parse(res.content[0].text), PAGE);
});

test("the schema offers the actor kinds, record and paging filters, flat", async () => {
  const { tools } = await withClient((client) => client.listTools());
  const tool = tools.find((t) => t.name === "didit_audit_log_list");
  const { properties } = tool.inputSchema;

  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(properties.actor_type.enum, ["member", "api_key", "system", "assistant_delegated", "investigator"]);
  assert.deepEqual(Object.keys(properties).sort(), [
    "action_category", "actor_type", "application_id", "created_at_end", "created_at_start",
    "organization_id", "page", "page_size", "search", "target_id", "target_type",
  ]);
  assert.ok(Object.values(properties).every((schema) => schema.type !== "object"), "no nested schemas");
  assert.match(tool.description, /actor_type 'investigator'/);
  assert.match(tool.description, /changes\.investigator\.outcome/);
});
