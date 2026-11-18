import { createRequire } from "node:module";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * an internal issue, end to end over the real verification path and the real HTTP transport.
 *
 * Reported: an access token from `POST /programmatic/login` listed the tools of the hosted server,
 * then every application-scoped call answered `not_found` or `forbidden` with no reason, and the
 * caller concluded their account was empty. Such a token is minted for one of the account's own
 * applications (service-didit-auth `programmatic_auth.py`), not for the MCP, so the hosted server
 * must refuse it at the FIRST request - tool list included - and say which two credentials it does
 * accept. A "Log in with Didit" grant and the console session the console's copilot relays keep
 * working exactly as before.
 */

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/introspect/";
process.env.MCP_CONSOLE_CLIENT_IDS = "console-client";
delete process.env.MCP_PUBLIC_DISCOVERY;
delete process.env.MCP_DEFAULT_ORG;

const require = createRequire(import.meta.url);
const { createHttpApp } = require("../dist/http.js");
const { MCP_AUTH_DOCS_URL } = require("../dist/auth/accepted-credentials.js");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A token the auth service knows: one per credential kind, keyed by the Bearer the test sends. */
const TOKENS = {
  // POST /programmatic/login: issued to the account's own application, user-data claims, no token_use.
  "programmatic.body.sig": {
    active: true,
    sub: "5bfe5319-625d-487c-a9c3-8f3cf50750b8",
    identifier: "new-customer@example.test",
    client_id: "client-of-the-application",
    claims: ["read:picture", "read:email", "read:names"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
  // A "Log in with Didit" grant: the consented scopes and the caller's org permissions.
  "grant.body.sig": {
    active: true,
    sub: "5bfe5319-625d-487c-a9c3-8f3cf50750b8",
    identifier: "customer@example.test",
    client_id: "console-client",
    token_use: "mcp",
    scope: "didit:management didit:verification",
    claims: [],
    org_permissions: ["read:workflows"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
  // The console session the console's copilot (didit-ai-assistant) relays to this server.
  "console.body.sig": {
    active: true,
    sub: "c0e0a0d0-1111-4222-8333-944455556666",
    identifier: "customer@example.test",
    client_id: "console-client",
    claims: [],
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
};

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target === process.env.DIDIT_OIDC_DISCOVERY_URL) {
    return json({
      issuer: "https://business.didit.me",
      authorization_endpoint: "https://business.didit.me/authorize",
      token_endpoint: "https://business.didit.me/api/auth/oauth-token",
      registration_endpoint: "https://business.didit.me/api/auth/oauth-register",
    });
  }
  if (target === process.env.MCP_OAUTH_INTROSPECT_URL) {
    const sent = JSON.parse(String(init?.body ?? "{}"));
    const answer = TOKENS[sent.token];
    return json(answer ?? { active: false });
  }

  // The console API the tools call. An empty organization is what a token that cannot act looks
  // like from here - which is exactly why the gate must answer before any tool runs.
  return json({ results: [] });
};

/** The JSON-RPC answer inside a streamable-HTTP response (an event stream, or a plain JSON body). */
function rpcAnswer(raw) {
  const data = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);

  return JSON.parse(data.length > 0 ? data[data.length - 1] : raw);
}

function post(server, body, headers = {}) {
  const { port } = server.address();
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function withApp(fn) {
  const server = (await createHttpApp()).listen(0);
  try {
    return await fn(server);
  } finally {
    server.close();
  }
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro", version: "1" } },
};
const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

test("a POST /programmatic/login token is refused at the first request, tool list included", async () => {
  await withApp(async (server) => {
    const bearer = { Authorization: "Bearer programmatic.body.sig" };

    // The handshake and the catalog: the two requests that used to half-succeed.
    const handshake = await post(server, initialize, bearer);
    assert.equal(handshake.status, 401, handshake.raw.slice(0, 300));
    const list = await post(server, toolsList, bearer);
    assert.equal(list.status, 401, `no tool list for a token this server does not accept: ${list.raw.slice(0, 300)}`);

    const body = JSON.parse(list.raw);
    assert.equal(body.error, "invalid_token");
    assert.match(body.error_description, /programmatic\/login/);
    assert.match(body.error_description, /sign in with Didit \(OAuth\)|signing in with Didit \(OAuth\)/);
    assert.match(body.error_description, /application API key/);
    assert.ok(body.error_description.includes(MCP_AUTH_DOCS_URL), "the refusal links the docs page");
    assert.equal(body.error_uri, MCP_AUTH_DOCS_URL);
    assert.equal(body.result, undefined);

    // The challenge still points at the sign-in, so a client that reads it can connect the right way.
    assert.match(String(list.headers["www-authenticate"]), /error="invalid_token"/);
    assert.match(
      String(list.headers["www-authenticate"]),
      /resource_metadata="https:\/\/mcp\.didit\.me\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });
});

test("an application-scoped tool call with that token is refused, never answered not_found", async () => {
  await withApp(async (server) => {
    await post(server, initialize, { Authorization: "Bearer programmatic.body.sig" });
    const call = await post(
      server,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "didit_workflow_list", arguments: {} } },
      { Authorization: "Bearer programmatic.body.sig" },
    );

    assert.equal(call.status, 401);
    const body = JSON.parse(call.raw);
    assert.equal(body.error, "invalid_token");
    assert.equal(body.result, undefined, "never a tool result the caller would read as 'no data'");
    assert.doesNotMatch(JSON.stringify(body), /not_found/);
  });
});

test("a Log in with Didit grant still lists and runs the catalog", async () => {
  await withApp(async (server) => {
    const bearer = { Authorization: "Bearer grant.body.sig" };

    const handshake = await post(server, initialize, bearer);
    assert.equal(handshake.status, 200, handshake.raw.slice(0, 300));

    const list = await post(server, toolsList, bearer);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(rpcAnswer(list.raw).result.tools.length > 100);

    const call = await post(
      server,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "didit_org_list", arguments: {} } },
      bearer,
    );
    assert.equal(call.status, 200);
    assert.equal(rpcAnswer(call.raw).result.isError, undefined, "the grant reaches the tools");
  });
});

test("the console session the console copilot relays is still served", async () => {
  await withApp(async (server) => {
    const bearer = { Authorization: "Bearer console.body.sig" };

    const handshake = await post(server, initialize, bearer);
    assert.equal(handshake.status, 200, handshake.raw.slice(0, 300));

    const list = await post(server, toolsList, bearer);
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.ok(rpcAnswer(list.raw).result.tools.length > 100);

    const call = await post(
      server,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "didit_org_list", arguments: {} } },
      bearer,
    );
    assert.equal(call.status, 200, "Ask Didit keeps its tools");
    assert.equal(rpcAnswer(call.raw).result.isError, undefined);
  });
});
