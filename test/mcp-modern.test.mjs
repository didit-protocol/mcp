import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modernGate,
  isModernRequest,
  handleModernRpc,
  decorateResult,
  MODERN_VERSION,
  SUPPORTED_VERSIONS,
} from "../dist/mcp-modern.js";

const META = "io.modelcontextprotocol/";

const modernHeaders = (method, name) => ({
  "mcp-protocol-version": MODERN_VERSION,
  "mcp-method": method,
  ...(name !== undefined ? { "mcp-name": name } : {}),
});
const modernParams = (extra = {}) => ({ ...extra, _meta: { [`${META}protocolVersion`]: MODERN_VERSION } });
const b64 = (text) => `=?base64?${Buffer.from(text, "utf8").toString("base64")}?=`;

// ── Gate: legacy bypass ──────────────────────────────────────────────────────
test("gate: no version at all bypasses (legacy initialize)", () => {
  const rpc = { id: 1, method: "initialize", params: {} };
  assert.equal(modernGate(rpc, {}), undefined);
  assert.equal(isModernRequest(rpc, {}), false);
});
test("gate: pre-2026 version header bypasses (legacy post-initialize traffic)", () => {
  const headers = { "mcp-protocol-version": "2025-06-18" };
  assert.equal(modernGate({ id: 1, method: "tools/list" }, headers), undefined);
  assert.equal(isModernRequest({ id: 1, method: "tools/list" }, headers), false);
});

// ── Gate: version negotiation ────────────────────────────────────────────────
test("gate: unknown future version → -32022 with supported list", () => {
  const error = modernGate({ id: 1, method: "tools/list" }, { "mcp-protocol-version": "2027-01-01" });
  assert.equal(error.code, -32022);
  assert.deepEqual(error.data.supported, SUPPORTED_VERSIONS);
  assert.equal(error.data.requested, "2027-01-01");
});
test("gate: valid modern request passes", () => {
  const rpc = { id: 1, method: "tools/list", params: modernParams() };
  assert.equal(modernGate(rpc, modernHeaders("tools/list")), undefined);
  assert.equal(isModernRequest(rpc, modernHeaders("tools/list")), true);
});

// ── Gate: mirrored headers (SEP-2243) ────────────────────────────────────────
test("gate: Mcp-Method not mirroring body method → -32020", () => {
  const rpc = { id: 1, method: "tools/list", params: modernParams() };
  assert.equal(modernGate(rpc, modernHeaders("tools/call")).code, -32020);
});
test("gate: version in header but missing from _meta → -32020", () => {
  const rpc = { id: 1, method: "tools/list", params: {} };
  assert.equal(modernGate(rpc, modernHeaders("tools/list")).code, -32020);
});
test("gate: tools/call Mcp-Name mirrors the tool name", () => {
  const rpc = { id: 1, method: "tools/call", params: modernParams({ name: "didit_session_list" }) };
  assert.equal(modernGate(rpc, modernHeaders("tools/call", "didit_session_list")), undefined);
  assert.equal(modernGate(rpc, modernHeaders("tools/call", "didit_other")).code, -32020);
  assert.equal(modernGate(rpc, modernHeaders("tools/call")).code, -32020);
});
test("gate: base64 sentinel value encoding for Mcp-Name", () => {
  const rpc = { id: 1, method: "tools/call", params: modernParams({ name: "wéird tool" }) };
  assert.equal(modernGate(rpc, modernHeaders("tools/call", b64("wéird tool"))), undefined);
});
test("gate: malformed base64 sentinel → -32020, never a crash", () => {
  const rpc = { id: 1, method: "tools/call", params: modernParams({ name: "didit_session_list" }) };
  const error = modernGate(rpc, modernHeaders("tools/call", "=?base64?!!!not-base64!!!?="));
  assert.equal(error.code, -32020);
});

// ── server/discover ──────────────────────────────────────────────────────────
test("server/discover: advertises versions, capabilities and identity", async () => {
  const reply = await handleModernRpc({ jsonrpc: "2.0", id: 7, method: "server/discover", params: modernParams() });
  assert.equal(reply.id, 7);
  assert.deepEqual(reply.result.supportedVersions, SUPPORTED_VERSIONS);
  assert.equal(reply.result.supportedVersions[0], MODERN_VERSION);
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.equal(typeof reply.result.ttlMs, "number");
  assert.equal(reply.result.cacheScope, "private");
  assert.equal(reply.result.resultType, "complete");
  assert.equal(reply.result._meta[`${META}serverInfo`].name, "didit");
});

// ── Modern dispatch through the SDK server ───────────────────────────────────
test("tools/list without initialize: dispatches and decorates", async () => {
  const reply = await handleModernRpc({ jsonrpc: "2.0", id: 3, method: "tools/list", params: modernParams() });
  assert.equal(reply.id, 3);
  assert.ok(Array.isArray(reply.result.tools) && reply.result.tools.length > 0);
  assert.match(reply.result.tools[0].name, /^didit_/);
  assert.equal(typeof reply.result.ttlMs, "number");
  assert.equal(reply.result.cacheScope, "private");
  assert.equal(reply.result.resultType, "complete");
  assert.equal(reply.result._meta[`${META}serverInfo`].name, "didit");
});
test("unknown method: SDK error envelope passes through undecorated", async () => {
  const reply = await handleModernRpc({ jsonrpc: "2.0", id: 4, method: "no/such-method", params: modernParams() });
  assert.equal(reply.id, 4);
  assert.equal(reply.error.code, -32601);
  assert.equal(reply.result, undefined);
});
test("notification (no id) → no response envelope (HTTP 202)", async () => {
  const reply = await handleModernRpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: modernParams() });
  assert.equal(reply, undefined);
});
test("envelope missing jsonrpc → -32600, never a hung request", async () => {
  const reply = await handleModernRpc({ id: 5, method: "tools/list", params: modernParams() });
  assert.equal(reply.error.code, -32600);
});
test("envelope with null id → -32600 (Zod would misread it as a notification)", async () => {
  const reply = await handleModernRpc({ jsonrpc: "2.0", id: null, method: "tools/list", params: modernParams() });
  assert.equal(reply.error.code, -32600);
});
test("envelope with non-object params → -32600, never a hung request", async () => {
  const reply = await handleModernRpc({ jsonrpc: "2.0", id: 6, method: "tools/list", params: "junk" });
  assert.equal(reply.error.code, -32600);
});

// ── Result decoration ────────────────────────────────────────────────────────
test("decorateResult: non-cacheable methods get no ttlMs/cacheScope", () => {
  const decorated = decorateResult("tools/call", { content: [] });
  assert.equal(decorated.ttlMs, undefined);
  assert.equal(decorated.cacheScope, undefined);
  assert.equal(decorated.resultType, "complete");
  assert.equal(decorated._meta[`${META}serverInfo`].name, "didit");
});
