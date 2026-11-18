import { createRequire } from "node:module";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

// claude.ai could not add https://mcp.didit.me/mcp as a connector ("could not verify the
// server", then no tools; "could not add the connector" with an x-api-key header), while a browser and
// the dual-Accept clients were served normally. The endpoint decides from `Accept` alone what a client
// gets: the streamable-HTTP transport refused anything that did not name both media types (406), and
// the connect page redirected any GET whose Accept merely mentioned `text/html`, including a client
// that had asked for JSON. These cases pin the answer to what each caller actually asked for.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/introspect/";
delete process.env.MCP_PUBLIC_DISCOVERY;
delete process.env.MCP_DEFAULT_ORG;

const require = createRequire(import.meta.url);
const { createHttpApp } = require("../dist/http.js");
const { connectPage } = require("../dist/connect-page.js");
const { acceptsMediaType, answerFormatFor, isBrowserNavigation, namesMediaType } = require("../dist/accept.js");

// The page at the server's own address is Didit's hosted page: the public mirror replaces
// src/connect-page.ts with the inert stub (scripts/sync-public.sh), and http.ts mounts no page
// there. Ask the build which one it is, the same way http.ts does, instead of assuming this
// tree's answer: the mirror runs this same file against its own build (test 245, run 43690112335).
const hasConnectPage = connectPage({ mcpUrl: process.env.MCP_RESOURCE_URI }) !== undefined;

const KEY = "sk_live_9f2c8a7b6d5e4f3a2b1c0d9e8f7a6b5c";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url) => {
  if (String(url) === process.env.DIDIT_OIDC_DISCOVERY_URL) {
    return json({
      issuer: "https://business.didit.me",
      authorization_endpoint: "https://business.didit.me/authorize",
      token_endpoint: "https://business.didit.me/api/auth/oauth-token",
      registration_endpoint: "https://business.didit.me/api/auth/oauth-register",
    });
  }
  if (String(url) === process.env.MCP_OAUTH_INTROSPECT_URL) {
    return json({
      active: true,
      token_use: "mcp",
      sub: "5bfe5319-625d-487c-a9c3-8f3cf50750b8",
      client_id: "client-of-the-application",
      organization_id: "69f2b990-24e3-4892-bbe7-1a6a628943b3",
      application_name: "Acme",
      claims: [],
      exp: Math.floor(Date.now() / 1000) + 3600,
      api_key: { uuid: "0b0b0b0b-1c1c-4d1d-8e1e-2f2f2f2f2f2f", label: "claude", prefix: "sk_live_9f2c", scopes: null },
    });
  }

  return json({ results: [] });
};

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } },
};

/** The JSON-RPC answer in either transport shape: an event stream, or a plain JSON body. */
function rpcAnswer(raw, contentType) {
  if (!String(contentType).includes("text/event-stream")) return JSON.parse(raw);
  const data = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);

  return JSON.parse(data[data.length - 1]);
}

function request(server, { method = "POST", path = "/mcp", body, accept, headers = {} } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path,
        method,
        headers: {
          ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
          ...(accept === undefined ? {} : { Accept: accept }),
          "x-api-key": KEY,
          "User-Agent": "Claude-User/1.0",
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
    if (payload !== undefined) req.write(payload);
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

test("a connector that names only JSON gets the handshake in JSON instead of a 406", async () => {
  await withApp(async (server) => {
    for (const accept of ["application/json", "application/json, */*;q=0.1", "*/*"]) {
      const answer = await request(server, { body: INITIALIZE, accept });

      assert.equal(answer.status, 200, `${accept}: ${answer.raw.slice(0, 200)}`);
      assert.match(String(answer.headers["content-type"]), /^application\/json/, accept);
      const negotiated = rpcAnswer(answer.raw, answer.headers["content-type"]);
      assert.equal(negotiated.id, 1);
      assert.equal(typeof negotiated.result.serverInfo.name, "string", accept);
      assert.equal(typeof negotiated.result.protocolVersion, "string", accept);
    }
  });
});

test("the catalog is listed to a JSON-only connection: 'no tools' is not a negotiation answer", async () => {
  await withApp(async (server) => {
    const list = await request(server, { body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, accept: "application/json" });

    assert.equal(list.status, 200, list.raw.slice(0, 300));
    const tools = JSON.parse(list.raw).result.tools;
    assert.ok(Array.isArray(tools) && tools.length > 100, `the catalog is served (${tools?.length} tools)`);
  });
});

test("a client that names an event stream keeps the stream it gets today", async () => {
  await withApp(async (server) => {
    for (const accept of ["application/json, text/event-stream", "text/event-stream", "text/event-stream;q=0.5, application/json"]) {
      const answer = await request(server, { body: INITIALIZE, accept });

      assert.equal(answer.status, 200, `${accept}: ${answer.raw.slice(0, 200)}`);
      assert.match(String(answer.headers["content-type"]), /^text\/event-stream/, accept);
      assert.equal(rpcAnswer(answer.raw, answer.headers["content-type"]).id, 1);
    }
  });
});

test("a caller that refuses the stream outright is answered in JSON, not in the stream it excluded", async () => {
  await withApp(async (server) => {
    const answer = await request(server, { body: INITIALIZE, accept: "text/event-stream;q=0, application/json" });

    assert.equal(answer.status, 200, answer.raw.slice(0, 200));
    assert.match(String(answer.headers["content-type"]), /^application\/json/);
    assert.equal(JSON.parse(answer.raw).id, 1);
  });
});

test("a caller that accepts neither media type still gets the transport's 406, in the protocol's envelope", async () => {
  await withApp(async (server) => {
    const answer = await request(server, { body: INITIALIZE, accept: "text/html" });

    assert.equal(answer.status, 406, answer.raw.slice(0, 200));
    assert.equal(JSON.parse(answer.raw).jsonrpc, "2.0");
  });
});

test("GET /mcp answers a browser with the page where the build has one, and a client with the protocol's 405", async () => {
  await withApp(async (server) => {
    const browser = await request(server, { method: "GET", accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
    if (hasConnectPage) {
      // The page is served in place: a redirect put the bare address in the address bar, and a
      // connector registered with it found no server there (http-bare-host.test.mjs).
      assert.equal(browser.status, 200, browser.raw.slice(0, 200));
      assert.equal(browser.headers.location, undefined);
      assert.match(String(browser.headers["content-type"]), /^text\/html/);
    } else {
      // No page in this build, so the browser is a caller the endpoint cannot serve: the protocol's
      // 405, the same answer every other GET gets, rather than an HTML page that is not there.
      assert.equal(browser.status, 405, browser.raw.slice(0, 200));
      assert.equal(JSON.parse(browser.raw).error.code, -32000);
    }

    // A client that can take HTML but asked for an MCP answer is not handed the page: it gets the
    // protocol's 405, which is the answer a client knows how to read.
    for (const accept of ["text/html, application/json, text/event-stream", "text/html;q=0.5, application/json", "*/*"]) {
      const client = await request(server, { method: "GET", accept });
      assert.equal(client.status, 405, `${accept}: ${client.raw.slice(0, 200)}`);
      assert.equal(JSON.parse(client.raw).error.code, -32000, accept);
    }
  });
});

test("the Accept header is read as media ranges, not as substrings", () => {
  assert.equal(answerFormatFor("application/json"), "json");
  assert.equal(answerFormatFor("application/*"), "json");
  assert.equal(answerFormatFor("*/*"), "json");
  assert.equal(answerFormatFor("application/json, text/event-stream"), "event-stream");
  assert.equal(answerFormatFor("text/event-stream"), "event-stream");
  assert.equal(answerFormatFor("text/event-stream;q=0, application/json"), "json");
  assert.equal(answerFormatFor("text/html"), undefined);
  assert.equal(answerFormatFor(undefined), undefined);

  assert.equal(namesMediaType("text/html;q=0.5", "text/html"), true);
  assert.equal(namesMediaType("*/*", "text/html"), false);
  assert.equal(acceptsMediaType("*/*", "application/json"), true);
  assert.equal(acceptsMediaType("text/html", "application/json"), false);
  // The most specific range that covers a type decides, wherever it stands in the header: a type
  // the caller refused by name is not let back in by a wildcard next to it.
  assert.equal(acceptsMediaType("application/*, application/json;q=0", "application/json"), false);
  assert.equal(acceptsMediaType("application/json;q=0, */*", "application/json"), false);
  assert.equal(acceptsMediaType("*/*;q=0, application/json", "application/json"), true);
  assert.equal(acceptsMediaType("*/*, application/*;q=0", "application/json"), false);
  assert.equal(acceptsMediaType("application/*;q=0, */*", "text/event-stream"), true);
  assert.equal(answerFormatFor("application/*, application/json;q=0"), undefined);

  assert.equal(isBrowserNavigation("text/html,application/xhtml+xml,*/*;q=0.8"), true);
  assert.equal(isBrowserNavigation("text/html, application/json"), false);
  assert.equal(isBrowserNavigation("*/*"), false);
  assert.equal(isBrowserNavigation(undefined), false);
});
