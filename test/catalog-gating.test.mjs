import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { PRIVILEGED_TOOL_DEFS } from "../dist/privileged-tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Directory-review contract (Anthropic MCP directory feedback, 2026-07):
//  1. Session deletion demands an explicit confirm:true - schema-required AND runtime-enforced,
//     so a single stray tool call can never wipe an application's sessions.
//  2. The hosted (remote OAuth) connector never carries account credentials through the
//     conversation: the account bootstrap tools are stdio-only, for every caller incl. staff.
//  3. The staff surface is never visible to public directory callers: on hosted servers only
//     per-token introspection (is_privileged) opens it - the DIDIT_IS_STAFF env override is a
//     stdio-only convenience and must not act deployment-wide.
//  4. Tool descriptions stay concise enough that directory listings don't truncate them
//     mid-sentence (the two workflow tools regressed on this in the 2026-07 review).

const ACCOUNT_TOOLS = [
  "didit_account_register",
  "didit_account_verify_email",
  "didit_account_resend_otp",
  "didit_account_login",
];

// The public open-source build swaps privileged-tools for an empty stub - staff-surface
// assertions only apply when the internal module is present.
const HAS_STAFF_SURFACE = PRIVILEGED_TOOL_DEFS.length > 0;

// Developer-machine env would flip bearer/staff detection under the tests.
delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;

async function withClient({ hosted = false, authInfo } = {}, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(hosted ? { hosted: true } : {});
  await server.connect(serverTransport);
  if (authInfo) {
    // The SDK hands transport-level auth to handlers via onmessage's extra param
    // (RequestHandlerExtra.authInfo) - the same route the HTTP transport uses for req.auth.
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo });
  }
  const client = new Client({ name: "catalog-gating-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const listNames = (opts) => withClient(opts, async (c) => (await c.listTools()).tools.map((t) => t.name));

test("session delete tools schema-require confirm", async () => {
  await withClient({}, async (c) => {
    const { tools } = await c.listTools();
    for (const name of ["didit_session_delete", "didit_session_batch_delete"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} missing from tools/list`);
      assert.equal(tool.inputSchema.properties.confirm?.type, "boolean", `${name} must declare a confirm param`);
      assert.ok(tool.inputSchema.required.includes("confirm"), `${name} must schema-require confirm`);
    }
  });
});

test("session deletes without confirm:true are refused at runtime", async () => {
  await withClient({}, async (c) => {
    for (const call of [
      { name: "didit_session_delete", arguments: { session_id: "11111111-1111-4111-8111-111111111111" } },
      { name: "didit_session_delete", arguments: { session_id: "11111111-1111-4111-8111-111111111111", confirm: false } },
      { name: "didit_session_batch_delete", arguments: { session_numbers: [1, 2] } },
      { name: "didit_session_batch_delete", arguments: { delete_all: true } },
    ]) {
      const res = await c.callTool(call);
      assert.equal(res.isError, true, `${call.name} must refuse without confirm:true`);
      assert.match(res.content[0].text, /confirm/i, `${call.name} refusal must point at confirm`);
    }
  });
});

test("hosted catalog excludes account bootstrap tools; stdio keeps them", async () => {
  const stdio = await listNames({});
  for (const name of ACCOUNT_TOOLS) assert.ok(stdio.includes(name), `${name} missing from stdio catalog`);
  const hosted = await listNames({ hosted: true });
  for (const name of ACCOUNT_TOOLS) assert.ok(!hosted.includes(name), `${name} leaked into the hosted catalog`);
});

test("hosted connector refuses account bootstrap calls outright", async () => {
  await withClient({ hosted: true }, async (c) => {
    const res = await c.callTool({ name: "didit_account_login", arguments: { email: "a@b.c", password: "x" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not available on the hosted connector/);
  });
});

test("hosted staff token keeps the staff surface but still no account tools", { skip: !HAS_STAFF_SURFACE }, async () => {
  const names = await listNames({
    hosted: true,
    authInfo: { token: "tok", clientId: "test", scopes: [], extra: { is_privileged: true } },
  });
  assert.ok(names.some((n) => n.startsWith("didit_staff_")), "introspected staff token must keep the staff surface");
  for (const name of ACCOUNT_TOOLS) assert.ok(!names.includes(name), `${name} leaked to a hosted staff catalog`);
});

test("DIDIT_IS_STAFF env override opens the staff surface on stdio only", { skip: !HAS_STAFF_SURFACE }, async () => {
  process.env.DIDIT_IS_STAFF = "true";
  try {
    const hosted = await listNames({ hosted: true, authInfo: { token: "tok", clientId: "test", scopes: [] } });
    assert.ok(
      !hosted.some((n) => n.startsWith("didit_staff_")),
      "a deployment-wide env var must never expose staff tools to hosted callers",
    );
    const stdio = await listNames({});
    assert.ok(stdio.some((n) => n.startsWith("didit_staff_")), "env override should still work for the stdio owner");
  } finally {
    delete process.env.DIDIT_IS_STAFF;
  }
});

test("staff tools stay hidden and uncallable for ordinary hosted callers", { skip: !HAS_STAFF_SURFACE }, async () => {
  const authInfo = { token: "tok", clientId: "test", scopes: [] };
  const names = await listNames({ hosted: true, authInfo });
  assert.ok(!names.some((n) => n.startsWith("didit_staff_")), "staff tools leaked to a non-staff hosted caller");
  await withClient({ hosted: true, authInfo }, async (c) => {
    const res = await c.callTool({ name: "didit_staff_org_list", arguments: {} });
    assert.equal(res.isError, true, "calling a staff tool without a staff token must be rejected");
    assert.match(res.content[0].text, /privileged/i);
  });
});

test("workflow_create / edit_graph descriptions stay concise and complete for the directory", async () => {
  await withClient({}, async (c) => {
    const { tools } = await c.listTools();
    for (const name of ["didit_workflow_create", "didit_workflow_edit_graph"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} missing from tools/list`);
      assert.ok(
        tool.description.length <= 1024,
        `${name} description is ${tool.description.length} chars - directory listings truncate long descriptions mid-sentence`,
      );
      assert.match(tool.description.trim(), /\.$/, `${name} description must end as a complete sentence`);
    }
  });
});
