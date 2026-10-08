import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { dropBlankOptionals } from "../dist/blank-args.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Prod 16-17 Sep 2026 (didit-ai-assistant, gpt-5.6-luna): the model fills every
// declared argument and blanks the ones it has no value for. `date_from: ""` on
// didit_session_search reached the console API as-is and came back as 400
// "date_from: Enter a valid date."; `label: ""` on a workflow-check tool
// resolved to "Several workflows are labelled """. The dispatcher now drops blank
// OPTIONAL arguments; a blank REQUIRED argument still reaches its handler.

const SCHEMA = {
  properties: {
    session_id: { type: "string" },
    date_from: { type: "string" },
    status: { type: "string" },
    next: { type: ["string", "null"] },
    limit: { type: "string" },
  },
  required: ["session_id"],
};

test("blank optional strings and non-nullable nulls are dropped, values are kept", () => {
  const args = { session_id: "s1", date_from: "", status: null, next: null, limit: "5" };

  assert.deepEqual(dropBlankOptionals(args, SCHEMA), { session_id: "s1", next: null, limit: "5" });
});

test("a blank required argument is left for its handler to report", () => {
  const args = { session_id: "", limit: "5" };

  assert.equal(dropBlankOptionals(args, SCHEMA), args);
});

test("a healthy call and a call without a schema are returned untouched", () => {
  const healthy = { session_id: "s1", date_from: "2026-09-01" };

  assert.equal(dropBlankOptionals(healthy, SCHEMA), healthy);
  assert.equal(dropBlankOptionals(healthy, undefined), healthy);
  assert.equal(dropBlankOptionals(undefined, SCHEMA), undefined);
});

/** Call one tool through the real MCP dispatcher and capture what it fetched. */
async function fetchedFor(name, args) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });

    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  process.env.DIDIT_ACCESS_TOKEN = "blank-args-token";
  process.env.MCP_DEFAULT_ORG = "org-1";
  process.env.MCP_DEFAULT_APP = "app-1";
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "blank-args-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }

  return calls.find((call) => /\/(sessions|webhook)\//.test(call.url)) ?? { url: "" };
}

test("the prod call's blank date filters never reach the console API", async () => {
  const { url } = await fetchedFor("didit_session_list", {
    status: "",
    date_from: "",
    date_to: "",
    limit: "5",
  });

  assert.match(url, /\/organization\/org-1\/application\/app-1\/sessions\/\?/);
  assert.match(url, /limit=5/);
  assert.doesNotMatch(url, /date_from=|date_to=|status=/);
});

test("a blank on an update tool is kept: it may mean 'clear this field'", async () => {
  const { url, body } = await fetchedFor("didit_webhook_update", {
    destination_uuid: "dest-1",
    label: "",
  });

  assert.match(url, /\/webhook\/destinations\/dest-1\//);
  assert.deepEqual(body, { label: "" });
});
