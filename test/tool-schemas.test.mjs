import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Contract for file inputs on the ADVERTISED tool schemas (what MCP clients
// validate calls against). Every file parameter must be usable both locally
// (*_path) and hosted (*_base64) — the hosted Didit Copilot can only supply
// inline base64, so a path-only or path-required schema makes the tool
// uncallable with user attachments. Regression guard for the pre-v5.0.5
// schema (required front_image_path, no *_base64), which broke chat
// attachments with "must have required property 'front_image_path'".

/** Tools whose schema must expose at least one *_path/*_base64 file input pair. */
const FILE_TOOLS = [
  "didit_verify_id",
  "didit_verify_poa",
  "didit_verify_passive_liveness",
  "didit_verify_face_match",
  "didit_verify_face_search",
  "didit_verify_age",
  "didit_branding_update",
  "didit_lists_entry_upload_face",
];

async function listAdvertisedTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "schema-contract-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test("file tools advertise *_base64 twins and never require a file param", async () => {
  const tools = await listAdvertisedTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of FILE_TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} missing from tools/list`);
    const props = tool.inputSchema?.properties ?? {};
    const required = tool.inputSchema?.required ?? [];
    const pathParams = Object.keys(props).filter((k) => k.endsWith("_path"));
    assert.ok(pathParams.length > 0, `${name} has no *_path file params`);
    for (const pathParam of pathParams) {
      const base64Param = pathParam.replace(/_path$/, "_base64");
      assert.ok(
        base64Param in props,
        `${name}: ${pathParam} has no ${base64Param} twin — hosted callers cannot pass files`,
      );
      assert.ok(
        !required.includes(pathParam) && !required.includes(base64Param),
        `${name}: file params must not be schema-required (either variant satisfies the input; presence is enforced at runtime by requireFileSource)`,
      );
    }
  }
});

// Google (Gemini) validates tool schemas strictly and 400s the WHOLE request
// when any array property lacks a typed `items` — e.g.
// "function_declarations[37].parameters.properties[operations].items.properties[branches].items: missing field".
// Anthropic tolerates untyped arrays, so this only surfaces when a client runs
// a Gemini model. One bad schema takes down every tool in the request, so the
// contract is global: every advertised array must carry usable `items`.
function findUntypedArrays(schema, path, out) {
  if (!schema || typeof schema !== "object") return out;
  if (Array.isArray(schema)) {
    schema.forEach((v, i) => findUntypedArrays(v, `${path}[${i}]`, out));
    return out;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("array")) {
    const items = schema.items;
    const typed =
      items &&
      typeof items === "object" &&
      !Array.isArray(items) &&
      ["type", "enum", "$ref", "anyOf", "oneOf", "allOf", "properties"].some((k) => k in items);
    if (!typed) out.push(path);
  }
  for (const [key, value] of Object.entries(schema)) {
    findUntypedArrays(value, `${path}.${key}`, out);
  }
  return out;
}

test("every advertised array schema has typed items (Gemini rejects untyped arrays)", async () => {
  const tools = await listAdvertisedTools();
  const offenders = [];
  for (const tool of tools) {
    findUntypedArrays(tool.inputSchema, tool.name, offenders);
  }
  assert.deepEqual(
    offenders,
    [],
    `Arrays without typed items (Gemini would 400 the whole request):\n${offenders.join("\n")}`,
  );
});

test("no tool anywhere requires a *_path or lacks its *_base64 twin", async () => {
  const tools = await listAdvertisedTools();
  for (const tool of tools) {
    const props = tool.inputSchema?.properties ?? {};
    const required = tool.inputSchema?.required ?? [];
    for (const key of Object.keys(props).filter((k) => k.endsWith("_path"))) {
      const twin = key.replace(/_path$/, "_base64");
      assert.ok(twin in props, `${tool.name}: ${key} has no ${twin} twin`);
      assert.ok(!required.includes(key), `${tool.name}: ${key} is schema-required`);
      assert.ok(!required.includes(twin), `${tool.name}: ${twin} is schema-required`);
    }
  }
});

test("questionnaire tools declare optional organization_id/application_id scoping params", async () => {
  // The questionnaire endpoints are org/app-scoped (orgAppPath), the Copilot's MCP
  // session carries no application context, and a schema-strict model cannot
  // pass a parameter the schema omits — so every didit_questionnaire_create
  // came back "application_id is required for this operation", even right
  // after didit_context_get had handed the model the id.
  const tools = await listAdvertisedTools();
  const questionnaires = tools.filter((t) => t.name.startsWith("didit_questionnaire_"));
  assert.equal(questionnaires.length, 6, `expected the questionnaire tool group, got ${questionnaires.length}`);
  for (const tool of questionnaires) {
    const properties = tool.inputSchema?.properties ?? {};
    const required = tool.inputSchema?.required ?? [];
    assert.ok(properties.organization_id, `${tool.name} must declare organization_id`);
    assert.ok(properties.application_id, `${tool.name} must declare application_id`);
    assert.ok(!required.includes("organization_id"), `${tool.name}: organization_id must stay optional`);
    assert.ok(!required.includes("application_id"), `${tool.name}: application_id must stay optional`);
  }
});

/**
 * Every tool whose handler resolves an org/app-scoped console path MUST
 * advertise organization_id + application_id.
 *
 * 38 of them did not (didit_lists_list, didit_webhook_list, the session /
 * transaction / vendor families…). `resolveApplicationId` reads the tool
 * ARGUMENT and, in hosted OAuth mode, nothing else — so a caller that cannot
 * see the parameter cannot pass it, and every call came back "application_id
 * is required for this operation", advice about a parameter the tool did not
 * have. It was the single largest failure class in the assistant's production
 * traces on 2026-08-25 (25 didit_lists_list, 9 didit_webhook_list in one
 * afternoon), read by users as the assistant being broken.
 */
const APP_SCOPED_TOOL_PREFIXES = [
  "didit_lists_",
  "didit_webhook_",
  "didit_branding_",
  "didit_vendor_",
  "didit_transaction_",
];

test("app-scoped tools advertise the ids their handler requires", async () => {
  const tools = await listAdvertisedTools();
  const appScoped = tools.filter(
    (t) => APP_SCOPED_TOOL_PREFIXES.some((p) => t.name.startsWith(p)) && !t.name.endsWith("_search"),
  );

  assert.ok(appScoped.length >= 20, `expected the app-scoped families, got ${appScoped.length}`);
  const missing = appScoped.filter((t) => {
    const properties = t.inputSchema?.properties ?? {};

    return !("organization_id" in properties) || !("application_id" in properties);
  });

  assert.deepEqual(missing.map((t) => t.name), [], "these tools require an app id they never advertise");
});

