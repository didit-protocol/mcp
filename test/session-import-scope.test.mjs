import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The session import routes are flat (`/session/imports/...`): for a person's token the API reads
// the organization from X-Didit-Organization-Id and the application from X-Didit-Application-Id,
// and refuses the call when it cannot tell them. The import tools declared no organization or
// application and sent no application header, so every import call people made in production on
// 12 November 2026 was refused (forbidden). Staging answered 200 once both headers were sent.

for (const name of ["DIDIT_ACCESS_TOKEN", "DIDIT_IS_STAFF", "MCP_DEFAULT_TOOLSETS", "MCP_PERMISSION_MODE", "DIDIT_DOCS_MCP_URL", "DIDIT_TOOLSETS", "DIDIT_READ_ONLY", "MCP_DEFAULT_ORG", "MCP_DEFAULT_APP"]) {
  delete process.env[name];
}

const { createServer } = await import("../dist/index.js");

const AUTH = "https://apx.didit.me/auth/v2";
const ORG = "0d6b5c1e-2f3a-4b7c-8d9e-1a2b3c4d5e6f";
const LIVE = "a1b2c3d4-0000-4000-8000-000000000001";
const SANDBOX = "a1b2c3d4-0000-4000-8000-000000000002";
const IMPORT = "1e9e0000-2222-4333-8444-555555555555";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Records every request (path and the scope headers) and answers like the API. */
function stubFetch() {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const headers = new Headers(init?.headers ?? {});
    requests.push({
      path: u.pathname,
      organization: headers.get("x-didit-organization-id"),
      application: headers.get("x-didit-application-id"),
      apiKey: headers.has("x-api-key"),
    });
    const route = `${u.origin}${u.pathname}`;
    if (route === `${AUTH}/organizations/me/`) return json([{ uuid: ORG, name: "Acme" }]);
    if (route === `${AUTH}/organizations/me/${ORG}/applications/`) {
      return json([{ uuid: LIVE, name: "Acme", mode: "live" }, { uuid: SANDBOX, name: "Acme (sandbox)", mode: "sandbox" }]);
    }
    return json({ results: [], providers: [], status: "paused" });
  };
  return requests;
}

async function withClient(authInfo, run) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  const client = new Client({ name: "session-import-scope-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const person = (token) => ({ token, clientId: "session-import-scope-test", scopes: [], extra: { organization_id: ORG } });
const importRequests = (requests) => requests.filter((request) => request.path.includes("/session/imports/"));
const textOf = (result) => (result.content ?? []).map((part) => part.text).join("\n");

const CALLS = [
  ["didit_session_list_import_providers", {}],
  ["didit_session_get_import_template", {}],
  ["didit_session_get_import", { import_id: IMPORT }],
  ["didit_session_get_import_errors", { import_id: IMPORT }],
  ["didit_session_manage_import", { import_id: IMPORT, action: "pause" }],
];

test("a person's import call names its organization and application in the headers the route reads", async () => {
  const requests = stubFetch();
  const original = globalThis.fetch;
  try {
    await withClient(person("imports.named.token"), async (client) => {
      for (const [name, args] of CALLS) {
        requests.length = 0;
        const result = await client.callTool({ name, arguments: { organization_id: ORG, application_id: SANDBOX, ...args } });
        assert.equal(result.isError, undefined, `${name}: ${textOf(result)}`);
        const sent = importRequests(requests);
        assert.equal(sent.length, 1, `${name} made one import request`);
        assert.equal(sent[0].organization, ORG, `${name}: X-Didit-Organization-Id`);
        assert.equal(sent[0].application, SANDBOX, `${name}: X-Didit-Application-Id`);
      }
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("a person with several applications who names none is told which ones they have, before any import request", async () => {
  const requests = stubFetch();
  const original = globalThis.fetch;
  try {
    await withClient(person("imports.unnamed.token"), async (client) => {
      const result = await client.callTool({ name: "didit_session_list_import_providers", arguments: {} });
      assert.equal(result.isError, true);
      const text = textOf(result);
      assert.match(text, /application_id/);
      assert.ok(text.includes(LIVE) && text.includes(SANDBOX), `the answer lists both applications: ${text}`);
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(importRequests(requests), [], "no import request is sent without an application");
});

test("the import tools declare the organization and application they act in", async () => {
  stubFetch();
  await withClient(person("imports.list.token"), async (client) => {
    const { tools } = await client.listTools();
    const names = [
      "didit_session_create_import", "didit_session_list_import_providers", "didit_session_check_import_provider",
      "didit_session_manage_import", "didit_session_get_import_template", "didit_session_get_import", "didit_session_get_import_errors",
    ];
    const imports = tools.filter((tool) => names.includes(tool.name));
    assert.equal(imports.length, names.length);
    for (const tool of imports) {
      assert.ok("organization_id" in tool.inputSchema.properties, `${tool.name} takes organization_id`);
      assert.ok("application_id" in tool.inputSchema.properties, `${tool.name} takes application_id`);
    }
  });
});

test("an API key connection sends no scope headers: the key is its application", async () => {
  const requests = stubFetch();
  const original = globalThis.fetch;
  const keyAuth = {
    token: "sk_test_import_scope_key",
    clientId: "api-key",
    scopes: [],
    extra: { credential: "api_key", api_key: { organizationId: ORG, applicationId: SANDBOX, mode: "sandbox", primary: true, restricted: false } },
  };
  try {
    await withClient(keyAuth, async (client) => {
      const result = await client.callTool({ name: "didit_session_list_import_providers", arguments: {} });
      assert.equal(result.isError, undefined, textOf(result));
    });
  } finally {
    globalThis.fetch = original;
  }
  const sent = importRequests(requests);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].apiKey, true);
  assert.equal(sent[0].application, null);
});
