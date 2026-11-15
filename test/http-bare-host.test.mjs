import { createRequire } from "node:module";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

// A claude.ai connector registered at the server's bare address, `https://mcp.didit.me`, could never
// connect (13 Nov 2026): Claude's check answered "Connecting to the server: Not found 404 ... Couldn't
// check the server", the Didit sign-in then SUCCEEDED (the discovery documents are served at the
// origin), and the connector ended with "your account was authorized, but no MCP server was found at
// the provided URL" and no tools. With an API key in a header it was "Could not add the connector".
// Production answered `POST /` with Express's 404 page and `GET /` with the HTML page, to a client.
//
// How the bare address gets into a client: a browser that opened `https://mcp.didit.me/mcp` was
// redirected to `/`, so the address bar, which is what a person copies, no longer held the server URL.
//
// These cases hold the bare address to being the server. What a browser gets there, and at the server
// URL, is the page's own test (connect-page.test.mjs): the open-source build has no page.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/introspect/";
delete process.env.MCP_PUBLIC_DISCOVERY;
delete process.env.MCP_DEFAULT_ORG;

const require = createRequire(import.meta.url);
const { createHttpApp } = require("../dist/http.js");

const TOKEN = "header.payload.signature";
const CLIENT = "application/json, text/event-stream";
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
      sub: "0e2f8a56-1d54-4c7b-9a57-5f0f6d1f2b11",
      client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      scope: "didit:management didit:verification",
      organization_id: "69f2b990-24e3-4892-bbe7-1a6a628943b3",
      claims: [],
      exp: Math.floor(Date.now() / 1000) + 3600,
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
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

/** The JSON-RPC answer in either transport shape: an event stream, or a plain JSON body. */
function rpcAnswer(answer) {
  if (!String(answer.headers["content-type"]).includes("text/event-stream")) return JSON.parse(answer.raw);
  const data = answer.raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);

  return JSON.parse(data[data.length - 1]);
}

function request(server, { method = "POST", path = "/", body, accept = CLIENT, signedIn = true, headers = {} } = {}) {
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
          // `accept: null` sends no Accept header at all, as curl with `-H "Accept:"` and some crawlers do.
          ...(accept === null ? {} : { Accept: accept }),
          ...(signedIn ? { Authorization: `Bearer ${TOKEN}` } : {}),
          "User-Agent": "Claude-User",
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

const toolNames = (answer) => rpcAnswer(answer).result.tools.map((tool) => tool.name);
/** `Vary` names this header itself: `Accept-Encoding`, which compression adds, is another header. */
const variesOn = (answer, header) =>
  String(answer.headers.vary ?? "")
    .split(",")
    .some((name) => name.trim().toLowerCase() === header);

test("a connector registered at the bare address gets the server, not a 404 page", async () => {
  await withApp(async (server) => {
    const handshake = await request(server, { path: "/", body: INITIALIZE });

    assert.equal(handshake.status, 200, handshake.raw.slice(0, 200));
    assert.equal(rpcAnswer(handshake).result.serverInfo.name, rpcAnswer(await request(server, { path: "/mcp", body: INITIALIZE })).result.serverInfo.name);

    const atRoot = toolNames(await request(server, { path: "/", body: LIST }));
    const atEndpoint = toolNames(await request(server, { path: "/mcp", body: LIST }));
    assert.ok(atRoot.length > 100, `the catalog is served (${atRoot.length} tools)`);
    assert.deepEqual(atRoot, atEndpoint, "the bare address is the same server as /mcp");
  });
});

test("the bare address reads the same connection options as /mcp", async () => {
  await withApp(async (server) => {
    const atRoot = toolNames(await request(server, { path: "/?toolsets=core&read_only=true", body: LIST }));
    const atEndpoint = toolNames(await request(server, { path: "/mcp?toolsets=core&read_only=true", body: LIST }));
    const everything = toolNames(await request(server, { path: "/mcp", body: LIST }));

    assert.deepEqual(atRoot, atEndpoint);
    assert.ok(atRoot.length > 0 && atRoot.length < everything.length, `a selection is a part of the catalog (${atRoot.length} of ${everything.length})`);
  });
});

test("without a credential the bare address challenges exactly like /mcp, so a client can find the sign-in", async () => {
  await withApp(async (server) => {
    const atRoot = await request(server, { path: "/", body: INITIALIZE, signedIn: false });
    const atEndpoint = await request(server, { path: "/mcp", body: INITIALIZE, signedIn: false });

    assert.equal(atRoot.status, 401, atRoot.raw.slice(0, 200));
    assert.equal(atRoot.headers["www-authenticate"], atEndpoint.headers["www-authenticate"]);
    assert.match(atRoot.headers["www-authenticate"], /resource_metadata="https:\/\/mcp\.didit\.me\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.deepEqual(JSON.parse(atRoot.raw), JSON.parse(atEndpoint.raw));
  });
});

test("an API key in a header connects at the bare address too", async () => {
  await withApp(async (server) => {
    const handshake = await request(server, {
      path: "/",
      body: INITIALIZE,
      signedIn: false,
      headers: { "x-api-key": "sk_live_9f2c8a7b6d5e4f3a2b1c0d9e8f7a6b5c" },
    });

    assert.equal(handshake.status, 200, handshake.raw.slice(0, 200));
    assert.equal(typeof rpcAnswer(handshake).result.serverInfo.name, "string");
  });
});

test("a client that asks the bare address for a stream gets the protocol's answer, never the page", async () => {
  await withApp(async (server) => {
    for (const accept of ["text/event-stream", "application/json, text/event-stream", "text/html, application/json, text/event-stream"]) {
      const atRoot = await request(server, { method: "GET", path: "/", accept });
      const atEndpoint = await request(server, { method: "GET", path: "/mcp", accept });

      assert.equal(atRoot.status, 405, `${accept}: ${atRoot.raw.slice(0, 120)}`);
      assert.match(String(atRoot.headers["content-type"]), /^application\/json/, accept);
      assert.equal(JSON.parse(atRoot.raw).jsonrpc, "2.0", accept);
      assert.equal(atRoot.status, atEndpoint.status, accept);
      assert.ok(variesOn(atRoot, "accept"), `${accept}: the answer depends on Accept, and says so`);
    }
    const teardown = await request(server, { method: "DELETE", path: "/" });
    assert.equal(teardown.status, 405);
    assert.equal(JSON.parse(teardown.raw).jsonrpc, "2.0");
  });
});

/** The refusal lines one call produced, parsed (auth/refusal-log.ts writes them with console.warn). */
async function refusalsOf(run) {
  const lines = [];
  const original = console.warn;
  console.warn = (line) => {
    const text = String(line);
    if (text.includes("hosted request")) lines.push(text);
    else original(line);
  };
  try {
    await run();
    // The response's `finish` and `close` listeners write the line; one macrotask later is enough.
    await new Promise((resolve) => setTimeout(resolve, 30));

    return lines.map((line) => JSON.parse(line));
  } finally {
    console.warn = original;
  }
}

test("a connector refused at the bare address leaves its line, and a person reading the page leaves none", async () => {
  await withApp(async (server) => {
    const refused = await refusalsOf(() => request(server, { path: "/", body: INITIALIZE, signedIn: false }));
    assert.equal(refused.length, 1, JSON.stringify(refused));
    assert.deepEqual(
      { path: refused[0].path, method: refused[0].method, status: refused[0].status, reason: refused[0].reason, client: refused[0].client },
      { path: "/", method: "POST", status: 401, reason: "missing_credential", client: "Claude-User" },
    );

    const probe = await refusalsOf(() => request(server, { method: "GET", path: "/", accept: "text/event-stream" }));
    assert.deepEqual(probe.map((line) => [line.path, line.method, line.status]), [["/", "GET", 405]]);

    // Everyone who is not a connector: a browser, a crawler, curl. And a connection that works.
    for (const accept of ["text/html,application/xhtml+xml,*/*;q=0.8", "*/*", null]) {
      const view = await refusalsOf(() => request(server, { method: "GET", path: "/", accept, signedIn: false }));
      assert.deepEqual(view, [], String(accept));
    }
    assert.deepEqual(await refusalsOf(() => request(server, { path: "/", body: INITIALIZE })), []);
  });
});
