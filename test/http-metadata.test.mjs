import { createRequire } from "node:module";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";

globalThis.fetch = async (url) => {
  assert.equal(String(url), process.env.DIDIT_OIDC_DISCOVERY_URL);
  return new Response(
    JSON.stringify({
      issuer: "https://business.didit.me",
      authorization_endpoint: "https://business.didit.me/authorize",
      token_endpoint: "https://business.didit.me/api/auth/oauth-token",
      registration_endpoint: "https://business.didit.me/api/auth/oauth-register",
      jwks_uri: "https://business.didit.me/.well-known/jwks.json",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["didit:management", "didit:verification"],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const require = createRequire(import.meta.url);
const { createHttpApp } = require("../dist/http.js");

function request(server, path, { method = "GET", body } = {}) {
  const { port } = server.address();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: raw ? JSON.parse(raw) : undefined,
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("protected-resource metadata advertises the actual /mcp transport resource", async (t) => {
  const app = await createHttpApp();
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const res = await request(server, path);
    assert.equal(res.status, 200);
    assert.equal(res.body.resource, "https://mcp.didit.me/mcp");
    assert.deepEqual(res.body.authorization_servers, ["https://business.didit.me"]);
    assert.deepEqual(res.body.scopes_supported, ["didit:management", "didit:verification"]);
  }
});

test("unauthenticated MCP challenge points at the path-specific resource metadata", async (t) => {
  const app = await createHttpApp();
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await request(server, "/mcp", { method: "POST", body: {} });

  assert.equal(res.status, 401);
  assert.match(
    res.headers["www-authenticate"],
    /resource_metadata="https:\/\/mcp\.didit\.me\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
});
