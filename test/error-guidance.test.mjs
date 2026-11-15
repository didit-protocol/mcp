import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { parseErrorBody, statusToHint } from "../dist/security.js";
import { apiKeyAuthInfo } from "../dist/api-key-connection.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// An error is the only thing a model has to go on for its next call. Each case here was an answer
// that sent it the wrong way, found on staging on 12 November 2026 while explaining why 8 of 82
// didit_session_create calls failed in production with `bad_request` and were retried unchanged:
//
//   - a call that NAMED its application was told to "Name the application in the
//     X-Didit-Application-Id header" (a header no caller of a tool can send), because the server
//     never passed the application on to the flat /session/ route;
//   - {"workflow_id": "Invalid workflow_id."} had no reader, so the reason was dropped and the answer
//     was "Request failed with status 400.";
//   - the hint of every 404 named two tools that do not exist.

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";
const ORG = "0d6b5c1e-2f3a-4b7c-8d9e-1a2b3c4d5e6f";
const LIVE = "a1b2c3d4-0000-4000-8000-000000000001";
const SANDBOX = "a1b2c3d4-0000-4000-8000-000000000002";
const WORKFLOW = "77777777-2222-4333-8444-555555555555";

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.MCP_DEFAULT_ORG;
delete process.env.MCP_DEFAULT_APP;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A person with two applications, and a /session/ route that answers what the test says. */
function stubBackend(sessionAnswer) {
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url).split("?")[0];
    if (path === `${AUTH}/organizations/me/`) return json([{ uuid: ORG, name: "Acme Trading" }]);
    if (path === `${AUTH}/organizations/me/${ORG}/applications/`) {
      return json([{ uuid: LIVE, name: "Acme Trading", mode: "live" }, { uuid: SANDBOX, name: "Acme Trading (sandbox)", mode: "sandbox" }]);
    }
    if (path === `${API}/session/` && init?.method === "POST") {
      posts.push({ headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), body: JSON.parse(init.body) });
      return sessionAnswer();
    }
    return json({ detail: "Not found." }, 404);
  };
  return posts;
}

let person = 0;
/** Each call is its own person: the organization map is cached per token. */
const personAuth = () => ({ token: `person.token.${++person}`, clientId: "client", scopes: [], extra: { sub: `user-${person}`, organization_id: ORG } });

async function callTool(name, args, authInfo = personAuth()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true, ...(authInfo.extra?.api_key ? { apiKey: true } : {}) });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  const client = new Client({ name: "error-guidance-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (result) => result.content.map((c) => c.text).join("\n");
const CREATED = () => json({ session_id: "5e552685-2222-4333-8444-555555555555", session_number: 2685, status: "Not Started", workflow_id: WORKFLOW }, 201);

/** The audit records written to stderr while `fn` runs. */
async function auditRecords(fn) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(JSON.parse(l).message));
}

test("didit_session_create passes the application the call names to the API", async () => {
  const posts = stubBackend(CREATED);

  const result = await callTool("didit_session_create", { organization_id: ORG, application_id: SANDBOX, workflow_id: WORKFLOW, vendor_data: "user-1" });

  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers["x-didit-application-id"], SANDBOX);
  assert.equal(posts[0].headers["x-didit-organization-id"], ORG);
  assert.match(posts[0].headers.authorization, /^Bearer person\.token\./);
  assert.deepEqual(posts[0].body, { workflow_id: WORKFLOW, vendor_data: "user-1" }, "the ids route the call; they are not session fields");
});

test("a call that names no application sends none: the API derives it from the workflow, as before", async () => {
  const posts = stubBackend(CREATED);

  const result = await callTool("didit_session_create", { workflow_id: WORKFLOW, vendor_data: "user-1" });

  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(posts[0].headers["x-didit-application-id"], undefined);
});

test("an API key is its application: no application header, and the key goes out as x-api-key", async () => {
  const posts = stubBackend(CREATED);
  const key = apiKeyAuthInfo("k".repeat(40), { active: true, sub: SANDBOX, client_id: "client", organization_id: ORG, organization_name: "Acme Trading", application_name: "Acme Trading (sandbox)", application_mode: "sandbox" });

  const result = await callTool("didit_session_create", { workflow_id: WORKFLOW, vendor_data: "user-1" }, key);

  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(posts[0].headers["x-didit-application-id"], undefined);
  assert.equal(posts[0].headers["x-api-key"], "k".repeat(40));
  assert.equal(posts[0].headers.authorization, undefined);
});

test("a workflow the named application does not have: the API's reason reaches the caller, with the field", async () => {
  stubBackend(() => json({ workflow_id: "Invalid workflow_id." }, 400));

  const records = await auditRecords(async () => {
    const result = await callTool("didit_session_create", { organization_id: ORG, application_id: SANDBOX, workflow_id: WORKFLOW, vendor_data: "user-1" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Error \[bad_request\]: workflow_id: Invalid workflow_id\.\nField: workflow_id\n/);
    assert.doesNotMatch(textOf(result), /Request failed with status/);
  });

  // The log line says which field the call got wrong. A name from the schema, never a value.
  assert.equal(records.length, 1);
  assert.equal(records[0].error_code, "bad_request");
  assert.equal(records[0].error_field, "workflow_id");
});

test("no application named and a workflow the API cannot find: told about the workflow, not about a header", async () => {
  const refusal = () => json({ detail: "Name the application in the X-Didit-Application-Id header.", code: "application_required" }, 403);

  stubBackend(refusal);
  const unknown = textOf(await callTool("didit_session_create", { workflow_id: WORKFLOW, vendor_data: "user-1" }));
  assert.match(unknown, /^Error \[bad_request\]: No workflow you can use has this workflow_id/);
  assert.match(unknown, /\nField: workflow_id\n/);
  assert.match(unknown, /not its name: didit_workflow_list returns the ids/);
  assert.match(unknown, /pass application_id as well/);
  assert.doesNotMatch(unknown, /header|X-Didit|different role/i);

  stubBackend(refusal);
  const missing = textOf(await callTool("didit_session_create", { vendor_data: "user-1" }));
  assert.match(missing, /^Error \[bad_request\]: workflow_id is required/);

  // With the application named, a 403 is about the person's role in it and is passed on as it is.
  stubBackend(() => json({ detail: "You do not have permission to perform this action." }, 403));
  const forbidden = textOf(await callTool("didit_session_create", { organization_id: ORG, application_id: SANDBOX, workflow_id: WORKFLOW, vendor_data: "user-1" }));
  assert.match(forbidden, /^Error \[forbidden\]: You do not have permission/);
});

test("a successful call records no error_field", async () => {
  stubBackend(CREATED);

  const records = await auditRecords(() => callTool("didit_session_create", { organization_id: ORG, application_id: SANDBOX, workflow_id: WORKFLOW, vendor_data: "user-1" }));

  assert.equal(records[0].outcome, "ok");
  assert.equal("error_field" in records[0], false);
});

test("parseErrorBody reads a field mapped to a plain string", () => {
  assert.deepEqual(parseErrorBody({ workflow_id: "Invalid workflow_id." }), { message: "workflow_id: Invalid workflow_id.", field: "workflow_id", allowed: undefined });
  assert.deepEqual(parseErrorBody({ callback: "Enter a valid URL.", workflow_id: "Invalid workflow_id." }), {
    message: "callback: Enter a valid URL.; workflow_id: Invalid workflow_id.",
    field: "callback",
    allowed: undefined,
  });
  // The shapes that already had a reader keep it.
  assert.equal(parseErrorBody({ detail: "Not found.", workflow_id: "ignored" }).message, "Not found.");
  assert.equal(parseErrorBody({ workflow_id: ["This field is required."] }).message, "workflow_id: This field is required.");
  // Not a field's message: the text of a body that was not JSON, and bookkeeping keys.
  assert.equal(parseErrorBody({ raw: "<html>Bad gateway</html>" }).message, undefined);
  assert.equal(parseErrorBody({ code: "throttled", status: "error" }).message, undefined);
  assert.equal(parseErrorBody({ workflow_id: "   " }).message, undefined);
});

test("every tool a status hint names is a tool that exists", async () => {
  const names = new Set();
  for (const options of [{}, { hosted: true }, { hosted: true, moneyTools: true }]) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(options);
    await server.connect(serverTransport);
    const client = new Client({ name: "error-guidance-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    for (const tool of (await client.listTools()).tools) names.add(tool.name);
    await client.close();
    await server.close();
  }
  let named = 0;
  for (const status of [400, 401, 402, 403, 404, 405, 409, 413, 415, 422, 429, 500, 502, 503, 504]) {
    for (const body of [{}, { allowed: ["a"] }]) {
      for (const tool of (statusToHint(status, body) ?? "").match(/\bdidit_[a-z_]+\b/g) ?? []) {
        named += 1;
        assert.ok(names.has(tool), `the ${status} hint names ${tool}, which no catalog lists`);
      }
    }
  }
  assert.ok(named >= 4, "the hints of 402 and 404 name tools");
});
