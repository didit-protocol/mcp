import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import {
  CHATGPT_CATALOG,
  CHATGPT_STRIPPED_PROPERTIES,
  RESTRICTED_INPUT_PROPERTY_PATTERN,
  applyCatalogProfile,
  catalogProfileRefusal,
  resolveCatalogProfile,
} from "../dist/catalog-profiles.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ChatGPT app-store contract (OpenAI review, rejections of 2026-07-06 / 07-09 / 08-17, appeal
// upheld 2026-08-25): no tool INPUT on the submitted endpoint may collect a restricted
// sensitive data type - government ID numbers, identity-document or face images, one-time
// codes. The `chatgpt` catalog profile (served at /mcp/chatgpt) is how the hosted server meets
// that without removing those tools from every other client. These tests pin the contract.

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;

// A hosted, OAuth-authenticated caller (what ChatGPT is), so the same gating the production
// endpoint applies (hosted exclusions, permission filter) is in effect underneath the profile.
const HOSTED_AUTH = { token: "test-bearer", clientId: "test", scopes: [], extra: { organization_id: "org-1" } };

async function withClient({ profile } = {}, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true, ...(profile ? { profile } : {}) });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo: HOSTED_AUTH });
  const client = new Client({ name: "catalog-profiles-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const listTools = (profile) => withClient({ profile }, async (c) => (await c.listTools()).tools);

/** Every property name declared anywhere inside a JSON schema (nested objects, arrays, oneOf...). */
function propertyNames(schema, out = new Set()) {
  if (!schema || typeof schema !== "object") return out;
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, out);
    return out;
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, value] of Object.entries(schema.properties)) {
      out.add(key);
      propertyNames(value, out);
    }
  }
  for (const key of ["items", "additionalProperties", "oneOf", "anyOf", "allOf", "not", "then", "else", "if"]) {
    if (key in schema) propertyNames(schema[key], out);
  }
  return out;
}

test("chatgpt profile serves exactly the allow-list, and every allow-listed tool exists", async () => {
  const names = (await listTools("chatgpt")).map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "no duplicate tool names");
  for (const name of names) assert.ok(CHATGPT_CATALOG.has(name), `${name} is not on the ChatGPT allow-list`);
  for (const name of CHATGPT_CATALOG) assert.ok(names.includes(name), `${name} is allow-listed but not in the catalog`);
  assert.equal(names.length, CHATGPT_CATALOG.size);
  assert.ok(names.length <= 50, `ChatGPT catalog should stay small, got ${names.length}`);
});

test("chatgpt profile advertises no restricted input property at any depth", async () => {
  const tools = await listTools("chatgpt");
  const offenders = [];
  for (const tool of tools) {
    for (const key of propertyNames(tool.inputSchema)) {
      if (RESTRICTED_INPUT_PROPERTY_PATTERN.test(key)) offenders.push(`${tool.name}.${key}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("chatgpt profile drops the standalone verification, face-upload, OTP and ID-number tools", async () => {
  const names = (await listTools("chatgpt")).map((t) => t.name);
  for (const name of names) assert.ok(!name.startsWith("didit_verify_"), `${name} must not be offered`);
  for (const name of [
    "didit_lists_entry_upload_face",
    "didit_session_update_data",
    "didit_verify_database",
    "didit_verify_aml",
    "didit_verify_id",
    "didit_verify_email_send",
    "didit_verify_phone_check",
    "didit_org_reveal_application_api_key",
    "didit_org_top_up",
  ]) {
    assert.ok(!names.includes(name), `${name} must not be offered`);
  }
});

test("session_create loses portrait_image only in the chatgpt profile", async () => {
  const full = (await listTools("full")).find((t) => t.name === "didit_session_create");
  const chatgpt = (await listTools("chatgpt")).find((t) => t.name === "didit_session_create");
  assert.ok(full.inputSchema.properties.portrait_image, "full catalog keeps portrait_image");
  assert.equal(chatgpt.inputSchema.properties.portrait_image, undefined);
  assert.ok(chatgpt.inputSchema.properties.workflow_id, "the rest of the schema survives");
  assert.deepEqual(Object.keys(CHATGPT_STRIPPED_PROPERTIES), ["didit_session_create"]);
});

test("full profile is the default and is unchanged by the profile machinery", async () => {
  const implicit = (await listTools(undefined)).map((t) => t.name);
  const explicit = (await listTools("full")).map((t) => t.name);
  assert.deepEqual(explicit, implicit);
  assert.ok(implicit.length > CHATGPT_CATALOG.size, "full catalog is larger than the ChatGPT one");
  // The full catalog still carries the verification tools the ChatGPT profile removes.
  assert.ok(implicit.includes("didit_verify_aml"));
});

test("tools/call on the chatgpt profile refuses tools and arguments outside the catalog", async () => {
  await withClient({ profile: "chatgpt" }, async (c) => {
    const outside = await c.callTool({ name: "didit_verify_aml", arguments: { full_name: "x" } });
    assert.equal(outside.isError, true);
    assert.match(outside.content[0].text, /not available on this endpoint/);

    const stripped = await c.callTool({
      name: "didit_session_create",
      arguments: { workflow_id: "11111111-1111-4111-8111-111111111111", portrait_image: "data:image/png;base64,AAAA" },
    });
    assert.equal(stripped.isError, true);
    assert.match(stripped.content[0].text, /portrait_image/);
  });
});

test("refusal helper: full profile never refuses; chatgpt refuses by name then by argument", () => {
  assert.equal(catalogProfileRefusal("full", "didit_verify_aml", {}), undefined);
  assert.equal(catalogProfileRefusal("full", "didit_session_create", { portrait_image: "x" }), undefined);
  assert.match(catalogProfileRefusal("chatgpt", "didit_verify_aml", {}), /not available/);
  assert.equal(catalogProfileRefusal("chatgpt", "didit_session_create", { workflow_id: "w" }), undefined);
  assert.match(catalogProfileRefusal("chatgpt", "didit_session_create", { portrait_image: "x" }), /portrait_image/);
});

test("applyCatalogProfile never mutates the shared tool definitions", () => {
  const tool = {
    name: "didit_session_create",
    inputSchema: { type: "object", properties: { workflow_id: { type: "string" }, portrait_image: { type: "string" } }, required: ["workflow_id"] },
  };
  const [reduced] = applyCatalogProfile([tool], "chatgpt");
  assert.equal(reduced.inputSchema.properties.portrait_image, undefined);
  assert.ok(tool.inputSchema.properties.portrait_image, "source definition untouched");
  assert.deepEqual(applyCatalogProfile([tool], "full"), [tool]);
});

test("resolveCatalogProfile accepts the known profiles and rejects typos", () => {
  assert.equal(resolveCatalogProfile(undefined), "full");
  assert.equal(resolveCatalogProfile(""), "full");
  assert.equal(resolveCatalogProfile("ChatGPT"), "chatgpt");
  assert.throws(() => resolveCatalogProfile("openai"), /Unknown MCP catalog profile/);
});
