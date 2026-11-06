import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttpApp } from "../dist/http.js";
import { requestContext } from "../dist/config.js";
import {
  getSignatureEvidence, getSignedDocument, getSignatureFieldImage, validateSignatures,
} from "../dist/tools/sessions.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0, 128, 255, 13, 10]), Buffer.from("%%EOF")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 1, 2, 255])]);
const credentials = { accessToken: "private-user-token", organizationId: "org-1" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const API = "https://verification.didit.me/v3";
const NODE = "node_sign_1";
const DOC = "11111111-1111-4111-8111-111111111111";
const FIELD = "22222222-2222-4222-8222-222222222222";

function setup(t) {
  const original = globalThis.fetch;
  const originalKey = process.env.MCP_PDF_DOWNLOAD_KEY;
  process.env.MCP_PDF_DOWNLOAD_KEY = "ab".repeat(32);
  const calls = [];
  let status = 200;
  let override;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes(".well-known/")) return json({});
    calls.push({ href, method: init?.method ?? "GET", body: init?.body });
    assert.equal(init.headers.Authorization, "Bearer private-user-token");
    if (href.includes("/validate/")) return override ? override() : json({ signatures: [{ id: "sig-1", validation: { valid: true } }] });
    if (status !== 200) return json({ detail: "Denied" }, status);
    if (href.includes("/image/")) return new Response(PNG, { headers: { "Content-Type": "image/png" } });
    return new Response(PDF, { headers: { "Content-Type": "application/pdf" } });
  };
  t.after(() => {
    globalThis.fetch = original;
    if (originalKey === undefined) delete process.env.MCP_PDF_DOWNLOAD_KEY;
    else process.env.MCP_PDF_DOWNLOAD_KEY = originalKey;
  });
  return { calls, setStatus: (value) => { status = value; }, setValidate: (fn) => { override = fn; } };
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
const as = (fn) => requestContext.run(credentials, fn);

test("evidence, signed document and field image each return a link whose download is the exact file", async (t) => {
  const { calls } = setup(t);
  const download = await startHttp(t);
  const cases = [
    [() => getSignatureEvidence("s-1", NODE, "sig-9"), "application/pdf", PDF, `${API}/session/s-1/signatures/${NODE}/evidence/?signature_id=sig-9`],
    [() => getSignedDocument("s-1", NODE, DOC), "application/pdf", PDF, `${API}/session/s-1/signatures/${NODE}/documents/${DOC}/file/`],
    [() => getSignatureFieldImage("s-1", NODE, FIELD), "image/png", PNG, `${API}/session/s-1/signatures/${NODE}/fields/${FIELD}/image/`],
  ];
  for (const [issue, contentType, bytes, upstream] of cases) {
    const link = await as(issue);
    assert.deepEqual(Object.keys(link).sort(), ["content_type", "download_url", "expires_at", "expires_in"]);
    assert.equal(link.content_type, contentType);
    assert.equal(link.expires_in, 300);
    assert.ok(!link.download_url.includes(credentials.accessToken));
    const tokenBytes = Buffer.from(new URL(link.download_url).searchParams.get("token"), "base64url");
    assert.ok(!tokenBytes.includes(Buffer.from(credentials.accessToken)));
    const response = await download(link.download_url);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], contentType);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.bytes, bytes);
    assert.equal(calls.at(-1).href, upstream);
  }
  // issuance + download each reach Didit once per file
  assert.equal(calls.length, 6);
});

test("evidence without signature_id sends no query, so the API picks the signer", async (t) => {
  const { calls } = setup(t);
  await as(() => getSignatureEvidence("s-1", NODE));
  assert.equal(calls[0].href, `${API}/session/s-1/signatures/${NODE}/evidence/`);
});

test("a tampered or empty link cannot fetch a signature file, and bad ids never reach Didit", async (t) => {
  const { calls } = setup(t);
  const download = await startHttp(t);
  const link = await as(() => getSignedDocument("s-1", NODE, DOC));
  const bad = new URL(link.download_url);
  const bytes = Buffer.from(bad.searchParams.get("token"), "base64url");
  bytes[30] ^= 1;
  bad.searchParams.set("token", bytes.toString("base64url"));
  assert.equal((await download(bad)).status, 403);
  bad.search = "";
  assert.equal((await download(bad)).status, 403);
  const before = calls.length;
  await assert.rejects(as(() => getSignedDocument("../x", NODE, DOC)));
  await assert.rejects(as(() => getSignatureFieldImage("s-1", "a/b", FIELD)));
  await assert.rejects(as(() => getSignedDocument("s-1", NODE, "")));
  assert.equal(calls.length, before);
});

test("authorization and the stored-file hash are enforced at issuance and rechecked on download", async (t) => {
  const { setStatus } = setup(t);
  const download = await startHttp(t);
  for (const status of [403, 404, 409]) {
    setStatus(status);
    await assert.rejects(as(() => getSignedDocument("s-1", NODE, DOC)), (error) => error.shape.status === status);
  }
  setStatus(200);
  const link = await as(() => getSignedDocument("s-1", NODE, DOC));
  for (const status of [403, 404, 409]) {
    setStatus(status);
    const response = await download(link.download_url);
    assert.equal(response.status, status === 409 ? 502 : status);
    assert.ok(!response.bytes.includes(Buffer.from(credentials.accessToken)));
  }
});

test("missing key, missing user and a non-PNG image fail without issuing a link", async (t) => {
  const { calls } = setup(t);
  delete process.env.MCP_PDF_DOWNLOAD_KEY;
  await assert.rejects(as(() => getSignedDocument("s-1", NODE, DOC)), /MCP_PDF_DOWNLOAD_KEY/);
  process.env.MCP_PDF_DOWNLOAD_KEY = "ab".repeat(32);
  await assert.rejects(getSignedDocument("s-1", NODE, DOC), /authenticated Didit user/);
  assert.equal(calls.length, 0);
  globalThis.fetch = async () => new Response(PDF, { headers: { "Content-Type": "image/png" } });
  await assert.rejects(as(() => getSignatureFieldImage("s-1", NODE, FIELD)), /invalid PNG image/);
});

test("validate posts the signer id when given and nothing else, and returns the checked signers", async (t) => {
  const { calls } = setup(t);
  const all = await as(() => validateSignatures("s-1", NODE));
  assert.equal(all.signatures[0].validation.valid, true);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].href, `${API}/session/s-1/signatures/${NODE}/validate/`);
  assert.deepEqual(JSON.parse(calls[0].body), {});
  await as(() => validateSignatures("s-1", NODE, "sig-9"));
  assert.deepEqual(JSON.parse(calls[1].body), { signature_id: "sig-9" });
});

test("permissions: the files need read:sessions, validate needs write:sessions", () => {
  for (const name of ["evidence", "signed_document", "field_image"].map((n) => n === "signed_document" ? "didit_session_get_signed_document" : `didit_session_get_signature_${n}`)) {
    assert.equal(TOOL_PERMISSIONS[name], "read:sessions", name);
  }
  assert.equal(TOOL_PERMISSIONS.didit_session_validate_signatures, "write:sessions");
});
