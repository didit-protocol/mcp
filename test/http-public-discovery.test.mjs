import { createRequire } from "node:module";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { profileServesWidgets } from "../dist/chatgpt-app.js";

// Mixed auth (config.ts MCP_PUBLIC_DISCOVERY). Hosts that probe an MCP server with
// `server/discover` BEFORE any OAuth dance (managed MCP hosting platforms' connect + publish
// checklist, directory crawlers) read an unconditional 401 as "cannot connect" rather than as
// an OAuth challenge, so the server is undiscoverable to them. The flag opens ONLY protocol
// negotiation. The tool catalog and every tool call stay behind the Bearer, and the flag is
// OFF by default so mcp.didit.me keeps answering 401 to everything.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";

globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      issuer: "https://business.didit.me",
      authorization_endpoint: "https://business.didit.me/authorize",
      token_endpoint: "https://business.didit.me/api/auth/oauth-token",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const require = createRequire(import.meta.url);

// The public open-source build swaps chatgpt-app for an inert stub: no second endpoint to probe.
const HAS_PROFILE_ENDPOINT = profileServesWidgets("chatgpt");

function post(server, path, body, headers = {}) {
  const { port } = server.address();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
};
const DISCOVER = {
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
};
const DISCOVER_HEADERS = { "MCP-Protocol-Version": "2026-07-28", "MCP-Method": "server/discover" };
const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const TOOLS_CALL = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "didit_org_list", arguments: {} } };

/** Build an app with the flag in a known state; the module reads it at import time. */
async function appWith(publicDiscovery, t) {
  const previous = process.env.MCP_PUBLIC_DISCOVERY;
  if (publicDiscovery) process.env.MCP_PUBLIC_DISCOVERY = "true";
  else delete process.env.MCP_PUBLIC_DISCOVERY;
  // Fresh module registry so config.ts re-reads the env for this case.
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { createHttpApp } = require("../dist/http.js");
  const server = (await createHttpApp()).listen(0);
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_PUBLIC_DISCOVERY;
    else process.env.MCP_PUBLIC_DISCOVERY = previous;
    return new Promise((resolve) => server.close(resolve));
  });
  return server;
}

test("default (flag off): every method still requires a Bearer, including initialize", async (t) => {
  const server = await appWith(false, t);
  for (const [label, body, headers] of [
    ["initialize", INITIALIZE, {}],
    ["server/discover", DISCOVER, DISCOVER_HEADERS],
    ["tools/list", TOOLS_LIST, {}],
    ["tools/call", TOOLS_CALL, {}],
  ]) {
    const res = await post(server, "/mcp", body, headers);
    assert.equal(res.status, 401, `${label} must stay authenticated by default`);
  }
});

test("flag on: protocol negotiation succeeds without a Bearer", async (t) => {
  const server = await appWith(true, t);

  const init = await post(server, "/mcp", INITIALIZE);
  assert.equal(init.status, 200);
  assert.match(init.raw, /"protocolVersion":"2025-06-18"/);
  assert.match(init.raw, /"serverInfo":\{"name":"didit"/);

  const discover = await post(server, "/mcp", DISCOVER, DISCOVER_HEADERS);
  assert.equal(discover.status, 200);
  assert.match(discover.raw, /"supportedVersions":\["2026-07-28"/);
});

test("flag on: the tool catalog and tool calls are STILL behind the Bearer", async (t) => {
  const server = await appWith(true, t);

  for (const [label, body] of [
    ["tools/list", TOOLS_LIST],
    ["tools/call", TOOLS_CALL],
  ]) {
    const res = await post(server, "/mcp", body);
    assert.equal(res.status, 401, `${label} must never be public`);
    // The challenge still drives RFC 9728 discovery, so a client can authenticate and retry.
    assert.match(
      res.headers["www-authenticate"],
      /resource_metadata="https:\/\/mcp\.didit\.me\/\.well-known\/oauth-protected-resource\/mcp"/,
      `${label} must still carry the OAuth challenge`,
    );
  }
});

test("flag on: the ChatGPT endpoint gets the same treatment, catalog included", { skip: !HAS_PROFILE_ENDPOINT }, async (t) => {
  const server = await appWith(true, t);

  const init = await post(server, "/mcp/chatgpt", INITIALIZE);
  assert.equal(init.status, 200);

  const list = await post(server, "/mcp/chatgpt", TOOLS_LIST);
  assert.equal(list.status, 401);
  assert.match(
    list.headers["www-authenticate"],
    /resource_metadata="https:\/\/mcp\.didit\.me\/\.well-known\/oauth-protected-resource\/mcp\/chatgpt"/,
  );
});

test("flag on: a batched body has no top-level method and stays authenticated", async (t) => {
  const server = await appWith(true, t);
  const res = await post(server, "/mcp", [INITIALIZE, TOOLS_LIST]);
  assert.equal(res.status, 401, "an array body must not slip past the Bearer gate");
});

test("flag on: a method that merely looks like a discovery method is not public", async (t) => {
  const server = await appWith(true, t);
  for (const method of ["initialized", "tools/initialize", "server/discover2", "prompts/list"]) {
    const res = await post(server, "/mcp", { jsonrpc: "2.0", id: 1, method });
    assert.equal(res.status, 401, `${method} must stay authenticated`);
  }
});
