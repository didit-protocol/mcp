import { createRequire } from "node:module";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

// Transport contract for requests a JSON-RPC client cannot even parse. The MCP Streamable
// HTTP transport answers an empty/invalid JSON-RPC body with a JSON-RPC error envelope, but a
// MALFORMED or OVERSIZED JSON body failed in Express's body parser before any route ran, so
// the client received Express's default HTML page ("Bad Request" / "Payload Too Large")
// instead of JSON-RPC. A connector only parses JSON-RPC, so it reported a protocol failure
// with no code, and the staging MCP answered exactly that way.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_JSON_BODY_LIMIT = "1kb";

globalThis.fetch = async (url) => {
  assert.equal(String(url), process.env.DIDIT_OIDC_DISCOVERY_URL);
  return new Response(
    JSON.stringify({
      issuer: "https://business.didit.me",
      authorization_endpoint: "https://business.didit.me/authorize",
      token_endpoint: "https://business.didit.me/api/auth/oauth-token",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const require = createRequire(import.meta.url);
const { createHttpApp } = require("../dist/http.js");

function post(server, path, raw) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(raw);
  });
}

async function withServer(t) {
  const app = await createHttpApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test("a malformed JSON body answers a JSON-RPC Parse error, never Express HTML", async (t) => {
  const server = await withServer(t);

  const res = await post(server, "/mcp", '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{');

  assert.equal(res.status, 400);
  assert.match(res.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(res.body), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error: Invalid JSON" },
  });
});

test("a body over the configured limit answers a JSON-RPC error, never Express HTML", async (t) => {
  const server = await withServer(t);

  const res = await post(server, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", padding: "x".repeat(4096) }));

  assert.equal(res.status, 413);
  assert.match(res.headers["content-type"], /^application\/json/);
  const body = JSON.parse(res.body);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, null);
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /size limit/);
});

test("a valid unauthenticated body still gets the OAuth challenge", async (t) => {
  const server = await withServer(t);

  const res = await post(server, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));

  assert.equal(res.status, 401);
  assert.match(res.headers["www-authenticate"], /resource_metadata=/);
});
