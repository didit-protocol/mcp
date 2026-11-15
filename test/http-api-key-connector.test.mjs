import { createRequire } from "node:module";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

// the customer's second attempt at the hosted connector was claude.ai's "No login" mode with an
// `x-api-key` header, which failed with "Could not add the connector". A header-only key is a supported
// connection (api-key-connection.ts), so this pins the whole path a connector drives: negotiation and the
// full catalog over the real HTTP transport, with no Bearer and no OAuth anywhere in the request.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/introspect/";
delete process.env.MCP_PUBLIC_DISCOVERY;
delete process.env.MCP_DEFAULT_ORG;

const require = createRequire(import.meta.url);
const { createHttpApp } = require("../dist/http.js");

const KEY = "sk_live_9f2c8a7b6d5e4f3a2b1c0d9e8f7a6b5c";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** What service-didit-auth answers when it introspects an application API key. */
const introspected = {
  active: true,
  sub: "5bfe5319-625d-487c-a9c3-8f3cf50750b8",
  client_id: "client-of-the-application",
  organization_id: "69f2b990-24e3-4892-bbe7-1a6a628943b3",
  application_name: "Acme",
  application_mode: "live",
  claims: [],
  exp: Math.floor(Date.now() / 1000) + 3600,
  api_key: {
    uuid: "0b0b0b0b-1c1c-4d1d-8e1e-2f2f2f2f2f2f",
    label: "claude",
    prefix: "sk_live_9f2c",
    primary: false,
    scopes: null,
    allowed_ips: [],
    expires_at: null,
  },
};

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target === process.env.DIDIT_OIDC_DISCOVERY_URL) {
    return json({
      issuer: "https://business.didit.me",
      authorization_endpoint: "https://business.didit.me/authorize",
      token_endpoint: "https://business.didit.me/api/auth/oauth-token",
      registration_endpoint: "https://business.didit.me/api/auth/oauth-register",
    });
  }
  if (target === process.env.MCP_OAUTH_INTROSPECT_URL) return json(introspected);

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

test("a connector with no sign-in connects with only an x-api-key header", async () => {
  await withApp(async (server) => {
    const initialize = await post(
      server,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } },
      },
      { "x-api-key": KEY, "User-Agent": "Claude-User/1.0" },
    );

    assert.equal(initialize.status, 200, initialize.raw.slice(0, 300));
    const negotiated = rpcAnswer(initialize.raw);
    assert.equal(negotiated.result.serverInfo.name.length > 0, true, "the handshake names the server");
    assert.equal(initialize.headers["www-authenticate"], undefined, "no OAuth challenge is offered to a key");

    const list = await post(server, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "x-api-key": KEY });
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    const tools = rpcAnswer(list.raw).result.tools;
    assert.ok(Array.isArray(tools) && tools.length > 100, `the catalog is served to the key (${tools?.length} tools)`);
    assert.ok(tools.every((tool) => typeof tool.name === "string" && tool.name.length > 0));
  });
});

test("a key the auth service refuses is a spec-shaped 401, not a dropped connection", async () => {
  const answer = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url) === process.env.MCP_OAUTH_INTROSPECT_URL
      ? json({ active: false })
      : answer(url);
  try {
    await withApp(async (server) => {
      const refused = await post(server, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "x-api-key": KEY });

      assert.equal(refused.status, 401);
      assert.match(String(refused.headers["www-authenticate"]), /resource_metadata="https:\/\/mcp\.didit\.me\/\.well-known\/oauth-protected-resource\/mcp"/);
    });
  } finally {
    globalThis.fetch = answer;
  }
});
