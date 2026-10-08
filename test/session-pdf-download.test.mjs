import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { createHttpApp } from "../dist/http.js";
import { requestContext } from "../dist/config.js";
import { generateSessionPdf } from "../dist/tools/sessions.js";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0, 128, 255, 13, 10]), Buffer.from("%%EOF")]);
const credentials = { accessToken: "private-user-token", organizationId: "org-1" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(t) {
  const original = globalThis.fetch;
  const originalKey = process.env.MCP_PDF_DOWNLOAD_KEY;
  process.env.MCP_PDF_DOWNLOAD_KEY = "ab".repeat(32);
  const calls = [];
  let status = 200;
  let contentType = "application/pdf";
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.includes(".well-known/")) return json({});
    if (path.endsWith("/organizations/me/")) return json([{ uuid: "org-1", name: "Test" }]);
    if (path.endsWith("/applications/")) return json([{ uuid: "app-1", name: "Test", mode: "sandbox" }]);
    assert.equal(path, "https://verification.didit.me/v3/session/session-1/generate-pdf/");
    assert.equal(init.headers.Authorization, "Bearer private-user-token");
    assert.equal(init.headers["X-Didit-Organization-Id"], "org-1");
    assert.equal(init.redirect, "error");
    calls.push(path);
    return status === 200 ? new Response(PDF, { headers: { "Content-Type": contentType } }) : json({ detail: "Denied" }, status);
  };
  t.after(() => {
    globalThis.fetch = original;
    if (originalKey === undefined) delete process.env.MCP_PDF_DOWNLOAD_KEY;
    else process.env.MCP_PDF_DOWNLOAD_KEY = originalKey;
  });
  return { calls, setStatus: (value) => { status = value; }, setContentType: (value) => { contentType = value; } };
}

async function startHttp(t) {
  const app = await createHttpApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (link) => new Promise((resolve, reject) => {
    const url = new URL(link);
    http.get({ hostname: "127.0.0.1", port: server.address().port, path: url.pathname + url.search }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}
const generate = () => requestContext.run(credentials, () => generateSessionPdf("session-1"));

test("MCP returns a short-lived URL, whose HTTP download preserves original binary bytes", async (t) => {
  setup(t);
  const download = await startHttp(t);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage.bind(serverTransport);
  serverTransport.onmessage = (msg, extra) => onmessage(msg, { ...extra, authInfo: {
    token: credentials.accessToken, clientId: "test", scopes: [], extra: { sub: "u1", organization_id: "org-1" },
  } });
  const client = new Client({ name: "pdf-test", version: "1" });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "didit_session_generate_pdf", arguments: { session_id: "session-1", organization_id: "org-1", application_id: "app-1" } });
  assert.ok(!result.isError, JSON.stringify(result));
  const body = JSON.parse(result.content.find((item) => item.type === "text").text);
  assert.deepEqual(Object.keys(body).sort(), ["download_url", "expires_at", "expires_in"]);
  assert.equal(body.expires_in, 300);
  assert.ok(Date.parse(body.expires_at) > Date.now());
  assert.ok(!JSON.stringify(result).includes("%PDF"));
  assert.ok(!body.download_url.includes(credentials.accessToken));
  const tokenBytes = Buffer.from(new URL(body.download_url).searchParams.get("token"), "base64url");
  assert.ok(!tokenBytes.includes(Buffer.from(credentials.accessToken)));
  const response = await download(body.download_url);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/pdf");
  assert.match(response.headers["content-disposition"], /^attachment;/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.bytes, PDF);
});

test("expired, tampered, missing and wrong-key links fail before accessing upstream", async (t) => {
  const { calls } = setup(t);
  const download = await startHttp(t);
  const link = await generate();
  const bad = new URL(link.download_url);
  const bytes = Buffer.from(bad.searchParams.get("token"), "base64url");
  bytes[30] ^= 1;
  bad.searchParams.set("token", bytes.toString("base64url"));
  assert.equal((await download(bad)).status, 403);
  bad.search = "";
  assert.equal((await download(bad)).status, 403);
  process.env.MCP_PDF_DOWNLOAD_KEY = "cd".repeat(32);
  assert.equal((await download(link.download_url)).status, 403);
  process.env.MCP_PDF_DOWNLOAD_KEY = "ab".repeat(32);
  const now = Date.now;
  Date.now = () => Date.parse(link.expires_at);
  try { assert.equal((await download(link.download_url)).status, 403); }
  finally { Date.now = now; }
  assert.equal(calls.length, 1);
});

test("PDF authorization is enforced at issuance and rechecked on download", async (t) => {
  const { setStatus } = setup(t);
  const download = await startHttp(t);
  for (const status of [401, 403, 404, 500]) {
    setStatus(status);
    await assert.rejects(generate(), (error) => error.shape.status === status);
  }
  setStatus(200);
  const link = await generate();
  for (const status of [401, 403, 404, 500]) {
    setStatus(status);
    const response = await download(link.download_url);
    assert.equal(response.status, status === 500 ? 502 : status);
    assert.ok(!response.bytes.includes(Buffer.from(credentials.accessToken)));
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("missing configuration, missing user, invalid session and non-PDF upstream fail without issuing a URL", async (t) => {
  const { calls, setContentType } = setup(t);
  delete process.env.MCP_PDF_DOWNLOAD_KEY;
  await assert.rejects(generate(), /MCP_PDF_DOWNLOAD_KEY/);
  process.env.MCP_PDF_DOWNLOAD_KEY = "ab".repeat(32);
  await assert.rejects(generateSessionPdf("session-1"), /authenticated Didit user/);
  await assert.rejects(requestContext.run(credentials, () => generateSessionPdf("../other")));
  assert.equal(calls.length, 0);
  setContentType("text/html");
  await assert.rejects(generate(), /did not return a PDF/);
});
