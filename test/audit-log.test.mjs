import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { canonicalJson, argsDigest } from "../dist/audit-log.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";

// Every tools/call leaves ONE structured line on stderr (the MCP server's own audit
// record) and every backend request carries a User-Agent naming the server AND the tool,
// so the backend's HTTP audit log attributes MCP-originated actions without any change.
// Argument values never reach the log — only their keys and a canonical digest.

const AUTH = "https://apx.didit.me/auth/v2";
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

delete process.env.DIDIT_ACCESS_TOKEN;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Route fetches by URL path; records the request init so headers can be asserted. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = routes[String(url).split("?")[0]];
    if (body === undefined) return json({ detail: "Forbidden." }, 403);
    return json(body);
  };
  return calls;
}

/** Capture the JSON audit lines written to stderr while `fn` runs. */
async function captureAuditLines(fn) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
}

const AUTH_INFO = {
  token: "tok-audit",
  clientId: "client-abc",
  scopes: [],
  extra: { sub: "user-42", organization_id: "org-1" },
};

async function callTool(name, args, opts = {}) {
  const { hosted = true } = opts;
  const authInfo = "authInfo" in opts ? opts.authInfo : AUTH_INFO;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(hosted ? { hosted: true } : {});
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo });
  const client = new Client({ name: "audit-log-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

test("canonicalJson ignores key order and drops undefined; the digest follows", () => {
  const a = { b: 1, a: { d: [1, 2], c: "x" }, e: undefined };
  const b = { a: { c: "x", d: [1, 2] }, b: 1 };

  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(argsDigest(a), argsDigest(b));
  assert.notEqual(argsDigest(a), argsDigest({ ...b, b: 2 }));
  assert.equal(argsDigest(a).length, 16);
});

test("a successful call logs one line with caller, tool, digest and keys but no values", async () => {
  stubFetch({ [`${AUTH}/organizations/me/`]: [{ uuid: "org-1", name: "Acme" }] });

  const [line, ...rest] = await captureAuditLines(async () => {
    const res = await callTool("didit_org_list", { organization_id: "org-1", note: "SECRET-VALUE" });
    assert.equal(res.isError, undefined, JSON.stringify(res.content));
  });

  assert.equal(rest.length, 0, "exactly one audit line per call");
  assert.equal(line.event, "mcp.tool_call");
  assert.equal(line.tool, "didit_org_list");
  assert.equal(line.outcome, "ok");
  assert.equal(line.transport, "hosted");
  assert.equal(line.sub, "user-42");
  assert.equal(line.organization_id, "org-1");
  assert.equal(line.client_id, "client-abc");
  assert.deepEqual(line.arg_keys, ["note", "organization_id"]);
  assert.equal(line.args_digest, argsDigest({ organization_id: "org-1", note: "SECRET-VALUE" }));
  assert.equal(typeof line.duration_ms, "number");
  assert.ok(!JSON.stringify(line).includes("SECRET-VALUE"), "argument values must never be logged");
});

test("a backend refusal logs outcome=error with the structured code and the confirm flag", async () => {
  stubFetch({});

  const [line] = await captureAuditLines(async () => {
    const res = await callTool("didit_session_delete", {
      organization_id: "org-1",
      application_id: "app-1",
      session_id: "11111111-1111-1111-1111-111111111111",
      confirm: true,
    });
    assert.equal(res.isError, true);
  });

  assert.equal(line.tool, "didit_session_delete");
  assert.equal(line.outcome, "error");
  assert.equal(line.error_code, "forbidden");
  assert.equal(line.confirm, true);
});

test("stdio calls are logged as such, even without auth info", async () => {
  process.env.DIDIT_ACCESS_TOKEN = "tok-stdio";
  stubFetch({ [`${AUTH}/organizations/me/`]: [] });

  const [line] = await captureAuditLines(async () => {
    await callTool("didit_org_list", {}, { hosted: false, authInfo: undefined });
  });
  delete process.env.DIDIT_ACCESS_TOKEN;

  assert.equal(line.transport, "stdio");
  assert.equal(line.sub, undefined);
  assert.deepEqual(line.arg_keys, []);
});

test("every backend request carries a User-Agent naming the server version and the tool", async () => {
  const calls = stubFetch({ [`${AUTH}/organizations/me/`]: [] });

  await captureAuditLines(() => callTool("didit_org_list", {}));

  assert.ok(calls.length > 0, "expected a backend call");
  assert.equal(calls[0].init.headers["User-Agent"], `didit-mcp-server/${VERSION} tool/didit_org_list`);
});
