import { createRequire } from "node:module";
import http from "node:http";
import zlib from "node:zlib";
import { test } from "node:test";
import assert from "node:assert/strict";

// tools/list is about 350 KB of JSON and every connection asks for it (about 33,000 times a day in
// production in November 2026). The hosted server now compresses what it sends (src/compress.ts).
// A client that does not ask for compression must get exactly what it got before, and an event
// stream must not be held back by the compressor.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/introspect/";
delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;
delete process.env.MCP_DEFAULT_TOOLSETS;

const require = createRequire(import.meta.url);
const express = require("express");
const { createHttpApp } = require("../dist/http.js");
const { compressResponses } = require("../dist/compress.js");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target === process.env.DIDIT_OIDC_DISCOVERY_URL) {
    return json({
      issuer: "https://business.didit.me",
      authorization_endpoint: "https://business.didit.me/authorize",
      token_endpoint: "https://business.didit.me/api/auth/oauth-token",
    });
  }
  if (target === process.env.MCP_OAUTH_INTROSPECT_URL) {
    return json({ active: true, sub: "u-1", organization_id: "org-1", exp: Math.floor(Date.now() / 1000) + 3600 });
  }
  return json({});
};

/** One request; the body comes back as the raw bytes that crossed the wire. */
function request(server, { method = "POST", path = "/mcp", body, headers = {} }) {
  const { port } = server.address();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer person.access.token",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const MODERN = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" };
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } };

async function withApp(fn) {
  const server = (await createHttpApp()).listen(0);
  try {
    return await fn(server);
  } finally {
    server.close();
  }
}

test("tools/list goes out gzip-compressed to a client that accepts it, at a fraction of the size", async () => {
  await withApp(async (server) => {
    const plain = await request(server, { body: listTools, headers: { ...MODERN, "Accept-Encoding": "identity" } });
    const packed = await request(server, { body: listTools, headers: { ...MODERN, "Accept-Encoding": "gzip" } });
    assert.equal(packed.status, 200);
    assert.equal(packed.headers["content-encoding"], "gzip");
    assert.match(packed.headers.vary, /Accept-Encoding/i);
    const unpacked = zlib.gunzipSync(packed.bytes);
    // The same answer, byte for byte, once unpacked.
    assert.deepEqual(JSON.parse(unpacked.toString("utf8")), JSON.parse(plain.bytes.toString("utf8")));
    assert.ok(JSON.parse(unpacked.toString("utf8")).result.tools.length > 100);
    assert.ok(plain.bytes.length > 100_000, `the uncompressed catalog is ${plain.bytes.length} bytes`);
    assert.ok(
      packed.bytes.length < plain.bytes.length / 4,
      `compressed ${packed.bytes.length} bytes of ${plain.bytes.length}: less than a quarter was expected`,
    );
  });
});

test("a client that does not ask for compression gets the answer as before", async () => {
  await withApp(async (server) => {
    for (const headers of [{ "Accept-Encoding": "identity" }, {}]) {
      const res = await request(server, { body: listTools, headers: { ...MODERN, ...headers } });
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], undefined);
      assert.ok(JSON.parse(res.bytes.toString("utf8")).result.tools.length > 100);
    }
  });
});

test("the handshake path (an event stream) is compressed too and still parses", async () => {
  await withApp(async (server) => {
    // No protocol-version header: the transport every client before 2026 uses, answered as an event stream.
    const legacy = { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} };
    const packed = await request(server, { body: legacy, headers: { "Accept-Encoding": "gzip" } });
    assert.equal(packed.status, 200, packed.bytes.toString("utf8").slice(0, 200));
    assert.match(packed.headers["content-type"], /text\/event-stream/);
    // The SDK marks its event streams no-transform, which the compressor reads as "never compress".
    // The origin still compresses, and the directive still reaches every proxy on the way.
    assert.equal(packed.headers["content-encoding"], "gzip");
    assert.equal(packed.headers["cache-control"], "no-cache, no-transform");
    const text = zlib.gunzipSync(packed.bytes).toString("utf8");
    const frame = text.split("\n").find((line) => line.startsWith("data:"));
    const message = JSON.parse(frame.slice(5));
    assert.equal(message.id, 7);
    assert.ok(message.result.tools.length > 100);

    const plain = await request(server, { body: legacy, headers: { "Accept-Encoding": "identity" } });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.headers["cache-control"], "no-cache, no-transform", "an uncompressed answer keeps its headers as they were");
    assert.equal(zlib.gunzipSync(packed.bytes).toString("utf8"), plain.bytes.toString("utf8"));
    assert.ok(packed.bytes.length < plain.bytes.length / 4);
  });
});

test("a small answer is left alone", async () => {
  await withApp(async (server) => {
    const health = await request(server, { method: "GET", path: "/healthz", headers: { "Accept-Encoding": "gzip" } });
    assert.equal(health.status, 200);
    assert.equal(health.headers["content-encoding"], undefined);
    assert.equal(JSON.parse(health.bytes.toString("utf8")).status, "ok");
  });
});

test("a refusal keeps its status and its OAuth challenge", async () => {
  await withApp(async (server) => {
    const res = await request(server, { body: listTools, headers: { ...MODERN, "Accept-Encoding": "gzip", Authorization: "" } });
    assert.equal(res.status, 401);
    assert.match(res.headers["www-authenticate"], /resource_metadata=/);
  });
});

test("an event written to an event stream arrives at once, not when the stream ends", async () => {
  // The compressor alone would hold "first" back until it had a full block or the stream ended.
  // No clock in the assertion: the server writes "second" only once the client has READ "first",
  // and gives up after a long wait, so a held-back event shows as "first" never arriving alone.
  const app = express();
  app.use(...compressResponses());
  let firstWasRead;
  const clientReadFirst = new Promise((resolve) => (firstWasRead = resolve));
  let gaveUp = false;
  app.get("/events", async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    let timer;
    const giveUp = new Promise((resolve) => {
      timer = setTimeout(() => ((gaveUp = true), resolve()), 5000);
    });
    await Promise.race([clientReadFirst, giveUp]);
    clearTimeout(timer);
    res.write("data: second\n\n");
    res.end();
  });
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const chunks = await new Promise((resolve, reject) => {
      const seen = [];
      http
        .get({ host: "127.0.0.1", port, path: "/events", headers: { "Accept-Encoding": "gzip" } }, (res) => {
          assert.equal(res.headers["content-encoding"], "gzip");
          const unpack = zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH });
          res.pipe(unpack);
          unpack.on("data", (chunk) => {
            seen.push(chunk.toString("utf8"));
            if (seen.join("").includes("first")) firstWasRead();
          });
          unpack.on("end", () => resolve(seen));
          unpack.on("error", reject);
        })
        .on("error", reject);
    });
    assert.equal(gaveUp, false, "the first event only arrived once the stream ended: it was held back");
    assert.equal(chunks.join(""), "data: first\n\ndata: second\n\n");
    assert.ok(chunks[0].includes("first") && !chunks[0].includes("second"), JSON.stringify(chunks));
  } finally {
    server.close();
  }
});

test("no-transform is hidden from the compressor only, whatever else Cache-Control says", async () => {
  const app = express();
  app.use(...compressResponses());
  const body = JSON.stringify({ text: "x".repeat(4096) });
  const cases = {
    "/only": "no-transform",
    "/first": "no-transform, no-cache",
    "/spaced": "private,  No-Transform ,max-age=0",
    "/none": "no-cache",
    "/absent": undefined,
  };
  for (const [path, cacheControl] of Object.entries(cases)) {
    app.get(path, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", ...(cacheControl ? { "Cache-Control": cacheControl } : {}) });
      res.end(body);
    });
  }
  const server = app.listen(0);
  try {
    const sent = async (path) => (await request(server, { method: "GET", path, headers: { "Accept-Encoding": "gzip" } })).headers;
    for (const path of Object.keys(cases)) {
      const headers = await sent(path);
      assert.equal(headers["content-encoding"], "gzip", path);
    }
    assert.equal((await sent("/only"))["cache-control"], "no-transform");
    assert.equal((await sent("/first"))["cache-control"], "no-cache, no-transform");
    assert.equal((await sent("/spaced"))["cache-control"], "private, max-age=0, no-transform");
    assert.equal((await sent("/none"))["cache-control"], "no-cache");
    assert.equal((await sent("/absent"))["cache-control"], undefined);
    // Not asked for: nothing is compressed and the header is exactly what the route set.
    const plain = await request(server, { method: "GET", path: "/spaced", headers: { "Accept-Encoding": "identity" } });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.headers["cache-control"], "private, max-age=0, no-transform");
  } finally {
    server.close();
  }
});

test("files that are compressed already are not compressed again", async () => {
  const app = express();
  app.use(...compressResponses());
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 0x41)]);
  app.get("/file.pdf", (_req, res) => {
    res.setHeader("Content-Type", "application/pdf");
    res.end(pdf);
  });
  const server = app.listen(0);
  try {
    const res = await request(server, { method: "GET", path: "/file.pdf", headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.headers["content-encoding"], undefined);
    assert.equal(res.bytes.length, pdf.length);
  } finally {
    server.close();
  }
});
