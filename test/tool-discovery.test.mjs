// The discovery tools: how a connection reaches the part of the catalog it did not load.
//
// A connection may list only part of the catalog (test/toolsets.test.mjs). didit_tool_search,
// didit_tool_describe, didit_tool_call_read and didit_tool_call_write keep everything else one
// step away. Two things have to hold for that to be safe and useful:
//
//   - a call through a discovery tool is checked exactly like a direct call: nothing becomes
//     reachable through them that the caller could not reach by naming the tool;
//   - the search finds the right tool from the words a person would use, because a tool that
//     cannot be found is a capability that was removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { CORE_TOOLSET, parseSelection } from "../dist/toolsets.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;
delete process.env.MCP_PERMISSION_MODE;
delete process.env.MCP_DEFAULT_TOOLSETS;

// Nothing here needs the network: every call is answered locally or refused before a request
// is made. A request that does go out is a bug in the test, so it fails loudly and at once.
globalThis.fetch = async (url) => {
  throw new Error(`unexpected network request in a discovery test: ${String(url)}`);
};

const HOSTED_AUTH = { token: "user-token", clientId: "test-client", scopes: [], extra: {} };
const select = (toolsets, readOnly = false) => parseSelection(toolsets, readOnly, CORE_TOOLSET);

async function withClient(options, fn, authInfo) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (authInfo) {
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, sendOptions) => send(message, { ...(sendOptions ?? {}), authInfo });
  }
  const server = createServer(options);
  await server.connect(serverTransport);
  const client = new Client({ name: "discovery-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const hosted = (fn, selection = select("core"), authInfo = HOSTED_AUTH) => withClient({ hosted: true, selection }, fn, authInfo);
const search = async (client, args) => (await client.callTool({ name: "didit_tool_search", arguments: args })).structuredContent;

/** Capture the audit records (one per tool call, as JSON in the `message` of a stderr line) written while `fn` runs. */
async function auditLines(fn) {
  const original = console.error;
  const lines = [];
  console.error = (line) => {
    try {
      const parsed = JSON.parse(JSON.parse(line).message);
      if (parsed.event === "mcp.tool_call") lines.push(parsed);
    } catch {
      /* not an audit line */
    }
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The tools themselves
// ---------------------------------------------------------------------------

test("the discovery tools are annotated so a client can tell a lookup from a change", async () => {
  await hosted(async (client) => {
    const byName = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    for (const name of ["didit_tool_search", "didit_tool_describe", "didit_tool_call_read"]) {
      assert.equal(byName.get(name).annotations.readOnlyHint, true, name);
      assert.equal(byName.get(name).annotations.destructiveHint, false, name);
    }
    const write = byName.get("didit_tool_call_write").annotations;
    assert.equal(write.readOnlyHint, false);
    assert.equal(write.destructiveHint, true, "it can run any change, so a client asks before each call");
    // The search tool's description is the one place every client shows what else exists.
    const description = byName.get("didit_tool_search").description;
    assert.match(description, /\d+ more tools are available/);
    for (const toolset of ["sessions", "workflows", "transactions", "verification"]) assert.match(description, new RegExp(`${toolset} \\(\\d+\\)`));
  });
});

test("search with no arguments gives the toolsets, with how many of their tools are loaded", async () => {
  await hosted(async (client) => {
    const overview = await search(client, {});
    const sessions = overview.toolsets.find((toolset) => toolset.id === "sessions");
    assert.ok(sessions.tools > sessions.loaded && sessions.loaded > 0, JSON.stringify(sessions));
    assert.ok(sessions.description.length > 10);
    assert.match(overview.next_step, /query/);
  });
});

test("search lists a whole toolset, marks what is loaded, and says how each tool behaves", async () => {
  await hosted(async (client) => {
    const cases = await search(client, { toolset: "cases" });
    const byName = new Map(cases.matches.map((match) => [match.name, match]));
    assert.equal(cases.total, cases.matches.length);
    assert.equal(byName.get("didit_case_search").loaded, true, "a core tool is already in the tool list");
    assert.equal(byName.get("didit_case_create").loaded, false);
    assert.equal(byName.get("didit_case_search").access, "read");
    assert.equal(byName.get("didit_case_create").access, "write");
    assert.equal(byName.get("didit_case_manage").access, "destructive");
    for (const match of cases.matches) {
      assert.equal(match.toolset, "cases");
      assert.ok(match.description.length > 0 && match.description.length <= 300, `${match.name} summary`);
      assert.equal(typeof match.parameters, "string");
    }
    // Required arguments are starred, enums are spelled out.
    assert.match(byName.get("didit_case_get").parameters, /case_id\*: string/);

    const unknown = await search(client, { toolset: "nope" });
    assert.deepEqual(unknown.matches, []);
    assert.match(unknown.next_step, /sessions/);
  });
});

// What a person would type, and the tool that has to come back for it. Each line is a
// capability that a short catalog would otherwise have removed.
const QUERIES = [
  ["export sessions to csv", "didit_report_export"],
  ["add a face to the blocklist", "didit_blocklist_add"],
  ["invite a teammate", "didit_org_invite_member"],
  ["create a workflow", "didit_workflow_create"],
  ["edit workflow graph add a step", "didit_workflow_edit_graph"],
  ["publish workflow", "didit_workflow_publish"],
  ["delete a session", "didit_session_delete"],
  ["download the verification PDF", "didit_session_generate_pdf"],
  ["bulk import sessions", "didit_session_create_import"],
  ["resend a webhook", "didit_session_webhook_resend"],
  ["share a session with a partner", "didit_session_share"],
  ["location evidence", "didit_session_get_location_evidence"],
  ["screen a crypto wallet", "didit_transaction_screen_wallet"],
  ["create a transaction monitoring rule", "didit_transaction_rule_create"],
  ["backtest a rule", "didit_transaction_rule_backtest"],
  ["verify a passport image", "didit_verify_id"],
  ["check if a person is on a sanctions list", "didit_verify_aml"],
  ["proof of address", "didit_verify_poa"],
  ["liveness check", "didit_verify_passive_liveness"],
  ["face match two photos", "didit_verify_face_match"],
  ["verify phone number with otp", "didit_verify_phone_send"],
  ["company registry lookup", "didit_verify_kyb_search"],
  ["change logo and colors", "didit_branding_update"],
  ["create a questionnaire", "didit_questionnaire_create"],
  ["list my invoices", "didit_billing_list_receipts"],
  ["what does a plan cost", "didit_billing_quote_plan"],
  ["who changed this setting audit", "didit_audit_log_list"],
  ["list members and roles", "didit_org_list_members"],
  ["escalate a case", "didit_case_manage"],
  ["delete user data gdpr", "didit_vendor_user_delete"],
  ["update vendor user status", "didit_vendor_user_update_status"],
  ["configure alerts", "didit_alert_configure"],
  ["investigator queue", "didit_investigator_queue_list"],
  ["approve investigator recommendation", "didit_investigator_accept"],
];

test("search finds the right tool from the words a person would use", async () => {
  await hosted(async (client) => {
    const misses = [];
    const notFirst = [];
    for (const [query, expected] of QUERIES) {
      const { matches } = await search(client, { query, limit: 3 });
      const rank = matches.findIndex((match) => match.name === expected);
      const line = `"${query}" -> ${matches.map((match) => match.name).join(", ")} (wanted ${expected})`;
      if (rank < 0) misses.push(line);
      else if (rank > 0) notFirst.push(line);
    }
    assert.deepEqual(misses, [], "the expected tool must be among the first three matches");
    assert.ok(
      notFirst.length <= QUERIES.length * 0.2,
      `${notFirst.length} of ${QUERIES.length} queries did not put the expected tool first:\n${notFirst.join("\n")}`,
    );
  });
});

test("search accepts an exact tool name, with or without the prefix, and says so when nothing matches", async () => {
  await hosted(async (client) => {
    assert.equal((await search(client, { query: "didit_lists_entry_upload_face" })).matches[0].name, "didit_lists_entry_upload_face");
    assert.equal((await search(client, { query: "lists_entry_upload_face" })).matches[0].name, "didit_lists_entry_upload_face");
    const nothing = await search(client, { query: "zzzz qqqq" });
    assert.deepEqual(nothing.matches, []);
    assert.match(nothing.next_step, /toolset/);
    assert.equal((await search(client, { query: "export", limit: 1 })).matches.length, 1);
  });
});

test("describe returns the full description and schema, and suggests names for a miss", async () => {
  await hosted(async (client) => {
    const { structuredContent } = await client.callTool({
      name: "didit_tool_describe",
      arguments: { names: ["didit_report_export", "report_get", "didit_report_exports"] },
    });
    const [exported, got] = structuredContent.tools;
    assert.equal(exported.name, "didit_report_export");
    assert.equal(exported.access, "write");
    assert.ok(exported.inputSchema.properties.kind, "the whole input schema, not a summary");
    assert.ok(exported.description.length > 100);
    assert.equal(got.name, "didit_report_get", "the prefix is optional");
    assert.equal(structuredContent.not_found[0].name, "didit_report_exports");
    assert.ok(structuredContent.not_found[0].did_you_mean.includes("didit_report_export"));

    const empty = await client.callTool({ name: "didit_tool_describe", arguments: {} });
    assert.match(empty.structuredContent.next_step, /names/);
  });
});

// ---------------------------------------------------------------------------
// Running a tool through a discovery tool
// ---------------------------------------------------------------------------

test("the read proxy runs a read-only tool and returns exactly what a direct call returns", async () => {
  await hosted(async (client) => {
    const direct = await client.callTool({ name: "didit_workflow_get_feature_config_schema", arguments: {} });
    const proxied = await client.callTool({
      name: "didit_tool_call_read",
      arguments: { name: "didit_workflow_get_feature_config_schema", arguments: {} },
    });
    assert.notEqual(proxied.isError, true, proxied.content?.[0]?.text);
    assert.deepEqual(proxied.structuredContent, direct.structuredContent);
    assert.equal(proxied.content[0].text, direct.content[0].text);
  });
});

test("the read proxy refuses a tool that changes data, and names the tool that runs it", async () => {
  await hosted(async (client) => {
    const result = await client.callTool({
      name: "didit_tool_call_read",
      arguments: { name: "didit_session_delete", arguments: { session_id: "11111111-1111-1111-1111-111111111111" } },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /changes data/);
    assert.match(result.content[0].text, /didit_tool_call_write/);
  });
});

test("a malformed proxy call is explained, and nested arguments sent as a JSON string are accepted", async () => {
  await hosted(async (client) => {
    const cases = [
      [{}, /`name`/],
      [{ name: "didit_tool_call_write", arguments: {} }, /discovery tool/],
      [{ name: "didit_workflow_get_feature_config_schema", arguments: "not json" }, /`arguments` must be an object/],
      [{ name: "didit_workflow_get_feature_config_schema", arguments: [1] }, /`arguments` must be an object/],
    ];
    for (const [args, pattern] of cases) {
      const result = await client.callTool({ name: "didit_tool_call_read", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, pattern, JSON.stringify(args));
    }
    const stringified = await client.callTool({
      name: "didit_tool_call_read",
      arguments: { name: "didit_workflow_get_feature_config_schema", arguments: "{}" },
    });
    assert.notEqual(stringified.isError, true, stringified.content?.[0]?.text);
    const unknown = await client.callTool({ name: "didit_tool_call_read", arguments: { name: "didit_nope_get", arguments: {} } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Unknown tool: didit_nope_get/);
  });
});

test("a proxied call passes through the same gates as a direct one", async () => {
  await hosted(async (client) => {
    // Hosted servers authenticate with OAuth: the sign-in tools are refused, proxied or not.
    for (const proxy of ["didit_tool_call_read", "didit_tool_call_write"]) {
      const login = await client.callTool({
        name: proxy,
        arguments: { name: "didit_account_login", arguments: { email: "a@b.co", password: "x" } },
      });
      assert.equal(login.isError, true, proxy);
      assert.match(login.content[0].text, /not available on the hosted connector|changes data/, proxy);
    }
    // The secret reveal and the money tool stay off a remote connector.
    const reveal = await client.callTool({
      name: "didit_tool_call_write",
      arguments: { name: "didit_org_reveal_application_api_key", arguments: { organization_id: "o", application_id: "a", confirm: true } },
    });
    assert.equal(reveal.isError, true);
    assert.match(reveal.content[0].text, /not available to a remote connector/);
    const topUp = await client.callTool({
      name: "didit_tool_call_write",
      arguments: { name: "didit_org_top_up", arguments: { amount_in_dollars: 50, confirm: true } },
    });
    assert.equal(topUp.isError, true);
    assert.match(topUp.content[0].text, /paid by the person in the Didit console/);
    // A confirm guard inside the tool still decides: without confirm nothing is deleted.
    const unconfirmed = await client.callTool({
      name: "didit_tool_call_write",
      arguments: { name: "didit_session_batch_delete", arguments: { session_ids: ["11111111-1111-1111-1111-111111111111"] } },
    });
    assert.equal(unconfirmed.isError, true);
    assert.match(unconfirmed.content[0].text, /confirm/i);
  });
});

test("the excluded tools are not discoverable either: search and describe only know what the caller may run", async () => {
  await hosted(async (client) => {
    for (const name of ["didit_account_login", "didit_org_reveal_application_api_key", "didit_org_top_up"]) {
      const found = await search(client, { query: name });
      assert.ok(!found.matches.some((match) => match.name === name), `${name} must not be found on a hosted connection`);
      const described = (await client.callTool({ name: "didit_tool_describe", arguments: { names: [name] } })).structuredContent;
      assert.deepEqual(described.tools, [], name);
    }
  });
});

test("a read-only connection discovers only tools that read", async () => {
  await hosted(
    async (client) => {
      const cases = await search(client, { toolset: "cases" });
      assert.ok(cases.matches.length > 0);
      assert.deepEqual(cases.matches.filter((match) => match.access !== "read").map((match) => match.name), []);
      const description = (await client.listTools()).tools.find((tool) => tool.name === "didit_tool_search").description;
      assert.match(description, /more read-only tools/);
      assert.doesNotMatch(description, /didit_tool_call_write/);
    },
    select("core", true),
  );
});

test("the permission pre-check judges the real tool of a proxied call", async () => {
  const previous = process.env.MCP_PERMISSION_MODE;
  process.env.MCP_PERMISSION_MODE = "enforce";
  try {
    const reader = { token: "t", clientId: "c", scopes: ["read:sessions", "list:sessions"], extra: { organization_id: "org-1" } };
    await hosted(
      async (client) => {
        const result = await client.callTool({
          name: "didit_tool_call_write",
          arguments: { name: "didit_blocklist_add", arguments: { session_id: "11111111-1111-1111-1111-111111111111" } },
        });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /missing_scope/);
        assert.match(result.content[0].text, /write:blocklist/);
        // A tool the role could never run is not something the search offers.
        const found = await search(client, { toolset: "lists" });
        assert.ok(!found.matches.some((match) => match.name === "didit_blocklist_add"));
      },
      select("core"),
      reader,
    );
  } finally {
    if (previous === undefined) delete process.env.MCP_PERMISSION_MODE;
    else process.env.MCP_PERMISSION_MODE = previous;
  }
});

test("the audit line names the real tool and the proxy it came through", async () => {
  await hosted(async (client) => {
    const lines = await auditLines(async () => {
      await client.callTool({ name: "didit_tool_call_read", arguments: { name: "didit_workflow_get_feature_config_schema", arguments: {} } });
      await client.callTool({ name: "didit_workflow_get_feature_config_schema", arguments: {} });
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].tool, "didit_workflow_get_feature_config_schema", "usage is counted on the tool that ran");
    assert.equal(lines[0].via, "didit_tool_call_read");
    assert.equal(lines[1].tool, "didit_workflow_get_feature_config_schema");
    assert.equal(lines[1].via, undefined);
  });
});

test("with nothing left to discover the discovery tools are not listed, and still answer when called", async () => {
  await hosted(
    async (client) => {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(!listed.includes("didit_tool_search"));
      const found = await search(client, { query: "export sessions to csv", limit: 1 });
      assert.equal(found.matches[0].loaded, true, "everything is loaded on this connection");
    },
    select("all"),
  );
});
