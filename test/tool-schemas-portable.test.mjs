import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// A client hands the tool list to a model API as it is. Those APIs check every definition and
// refuse the WHOLE request over one they do not accept: with two tools that declared "library_keys
// or bundle" as a top-level `anyOf`, the Claude API answered every request that carried the full
// catalog with
//
//   tools.89.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level
//
// so an agent built on it could not use the server at all, while the short catalogs (which did
// not list those two tools) worked. The rules below are the ones those APIs state for a tool
// definition; they hold for every tool on every catalog this server lists.

for (const name of ["DIDIT_ACCESS_TOKEN", "DIDIT_IS_STAFF", "MCP_DEFAULT_TOOLSETS"]) delete process.env[name];

const { createServer } = await import("../dist/index.js");

const PERSON = { token: "person.access.token", clientId: "portable-schemas-test", scopes: [], extra: { organization_id: "org-1" } };
const PRIVILEGED = { ...PERSON, extra: { ...PERSON.extra, is_privileged: true } };

async function listTools(options, authInfo) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  }
  const client = new Client({ name: "portable-schemas-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

const CATALOGS = {
  "the local server": () => listTools({}),
  "the hosted server, signed-in person": () => listTools({ hosted: true }, PERSON),
  "the hosted server, privileged caller": () => listTools({ hosted: true }, PRIVILEGED),
  "the hosted payments endpoint": () => listTools({ hosted: true, moneyTools: true }, PERSON),
  "the hosted ChatGPT catalog": () => listTools({ hosted: true, profile: "chatgpt" }, PERSON),
};

/** What the Claude API and the OpenAI API both require of a tool's name. */
const PORTABLE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** Keywords neither API accepts at the top level of a tool's input schema. */
const TOP_LEVEL_COMBINATORS = ["oneOf", "anyOf", "allOf"];

for (const [label, list] of Object.entries(CATALOGS)) {
  test(`every tool of ${label} is a definition a model API accepts`, async () => {
    const tools = await list();
    assert.ok(tools.length > 20, `${label} lists its tools`);
    const refused = [];
    for (const tool of tools) {
      const schema = tool.inputSchema ?? {};
      if (!PORTABLE_NAME.test(tool.name)) refused.push(`${tool.name}: the name is not 1 to 64 letters, digits, _ or -`);
      if (schema.type !== "object") refused.push(`${tool.name}: the input schema is not an object`);
      for (const keyword of TOP_LEVEL_COMBINATORS) {
        if (keyword in schema) {
          refused.push(`${tool.name}: ${keyword} at the top level of the input schema (say the rule in the description and enforce it in the handler)`);
        }
      }
      if (schema.properties !== undefined && (typeof schema.properties !== "object" || Array.isArray(schema.properties))) {
        refused.push(`${tool.name}: properties is not an object`);
      }
      const unknown = (schema.required ?? []).filter((key) => !(key in (schema.properties ?? {})));
      if (unknown.length > 0) refused.push(`${tool.name}: required names arguments that are not declared: ${unknown.join(", ")}`);
    }
    assert.deepEqual(refused, []);
  });
}
