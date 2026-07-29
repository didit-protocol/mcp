/**
 * MCP 2026-07-28 "modern era" support (SEP-2575/2243/2549): per-request version
 * gate, mirrored-header validation, server/discover and result decoration.
 * Legacy requests (any pre-2026 version, or no version at all) bypass the gate
 * untouched — POST /mcp is dual-era and keeps the `initialize` handshake for
 * old clients (Claude Code, Cursor, the SDK-based ones).
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { IncomingHttpHeaders } from "node:http";

import { createServer, SERVER_VERSION } from "./index";

export const MODERN_VERSION = "2026-07-28";
/** Advertised in server/discover and in -32022 error data: modern era + every SDK-negotiable legacy version. */
export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS];

const META = "io.modelcontextprotocol/";
/** Methods whose Mcp-Name header mirrors a body field (SEP-2243). */
const NAMED_FIELD: Record<string, string> = { "tools/call": "name", "resources/read": "uri" };
/** CacheableResult (SEP-2549) applies to discovery/list shapes; this server serves tools only. */
const CACHEABLE = new Set(["server/discover", "tools/list"]);
const CACHE_TTL_MS = 60_000;

export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { _meta?: Record<string, unknown>; [key: string]: unknown };
}

export interface ModernError {
  code: number;
  message: string;
  data?: unknown;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];

  return Array.isArray(value) ? value[0] : value;
}

function requestedVersion(rpc: RpcMessage, headers: IncomingHttpHeaders): string | undefined {
  return (
    headerValue(headers, "mcp-protocol-version") ??
    (rpc.params?._meta?.[`${META}protocolVersion`] as string | undefined)
  );
}

/** Modern-era requests pin a 2026+ protocol version on every message; legacy ones never do. */
export function isModernRequest(rpc: RpcMessage, headers: IncomingHttpHeaders): boolean {
  const requested = requestedVersion(rpc, headers);

  return requested !== undefined && requested >= MODERN_VERSION;
}

/** undefined → proceed (legacy or valid modern); otherwise answer HTTP 400 with this error. */
export function modernGate(rpc: RpcMessage, headers: IncomingHttpHeaders): ModernError | undefined {
  const requested = requestedVersion(rpc, headers);

  if (!requested || requested < MODERN_VERSION) return undefined;
  if (!SUPPORTED_VERSIONS.includes(requested)) {
    return {
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: SUPPORTED_VERSIONS, requested },
    };
  }

  return headerMismatch(rpc, headers);
}

function headerMismatch(rpc: RpcMessage, headers: IncomingHttpHeaders): ModernError | undefined {
  const namedField = NAMED_FIELD[rpc.method ?? ""];
  const mismatch =
    headerValue(headers, "mcp-protocol-version") !== rpc.params?._meta?.[`${META}protocolVersion`] ||
    headerValue(headers, "mcp-method") !== rpc.method ||
    (namedField !== undefined &&
      decodeSentinel(headerValue(headers, "mcp-name")) !== rpc.params?.[namedField]);

  return mismatch ? { code: -32020, message: "Header mismatch" } : undefined;
}

/** `=?base64?{utf8}?=` — the value encoding for header-unsafe Mcp-Name values (SEP-2243). */
function decodeSentinel(value: string | undefined): string | null | undefined {
  const encoded = value?.match(/^=\?base64\?(.+)\?=$/)?.[1];

  if (!encoded) return value;
  const bytes = Buffer.from(encoded, "base64");
  // Buffer.from silently drops malformed base64; a failed round-trip must reject
  // as a mismatch (400), never crash the request or silently pass validation.
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return null;

  return bytes.toString("utf8");
}

function discoverResult(): Record<string, unknown> {
  return { supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} } };
}

/** serverInfo on every result (SHOULD) + the mandatory CacheableResult fields. */
export function decorateResult(method: string, result: Record<string, unknown>): Record<string, unknown> {
  // tools/list varies per caller (privileged tools), so shared caches must not store it.
  const cacheable = CACHEABLE.has(method)
    ? { ttlMs: CACHE_TTL_MS, cacheScope: "private" }
    : undefined;

  return {
    ...result,
    ...cacheable,
    resultType: "complete",
    _meta: {
      ...(result._meta as Record<string, unknown> | undefined),
      [`${META}serverInfo`]: { name: "didit", version: SERVER_VERSION },
    },
  };
}

/** Everything the SDK's Zod schemas would silently drop: exact-"2.0" jsonrpc, string method, string|number id (or none, for notifications), object params. */
function invalidEnvelope(rpc: RpcMessage): boolean {
  return (
    rpc.jsonrpc !== "2.0" ||
    typeof rpc.method !== "string" ||
    (rpc.id !== undefined && typeof rpc.id !== "string" && typeof rpc.id !== "number") ||
    (rpc.params !== undefined && (typeof rpc.params !== "object" || rpc.params === null))
  );
}

/**
 * Dispatch one modern-era message into the SDK server without the initialize
 * handshake: an in-memory transport pair carries the message (and the caller's
 * AuthInfo, which the tool dispatch reads) straight to the request handlers.
 * Returns the JSON-RPC response envelope, or undefined for notifications.
 */
export async function handleModernRpc(
  rpc: RpcMessage,
  authInfo?: AuthInfo,
): Promise<Record<string, unknown> | undefined> {
  // The SDK's Protocol silently drops envelopes that fail schema validation, which
  // would leave this dispatch (and the HTTP request) hanging forever — reject first.
  if (invalidEnvelope(rpc)) {
    return { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (rpc.method === "server/discover") {
    return { jsonrpc: "2.0", id: rpc.id ?? null, result: decorateResult(rpc.method, discoverResult()) };
  }

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer();

  await server.connect(serverSide);
  try {
    if (rpc.id === undefined) {
      await clientSide.send(rpc as JSONRPCMessage, { authInfo } as never);

      return undefined;
    }
    const replied = new Promise<RpcMessage & { result?: Record<string, unknown>; error?: ModernError }>(
      (resolve) => {
        clientSide.onmessage = (message) => {
          const reply = message as RpcMessage & { result?: Record<string, unknown>; error?: ModernError };
          if (reply.id === rpc.id) resolve(reply);
        };
      },
    );

    await clientSide.send(rpc as JSONRPCMessage, { authInfo } as never);
    const reply = await replied;

    if (reply.error) {
      // 2026-07-28 renamed resource-not-found (-32002) to Invalid Params (-32602).
      const code = reply.error.code === -32002 ? -32602 : reply.error.code;

      return { jsonrpc: "2.0", id: rpc.id, error: { ...reply.error, code } };
    }

    return { jsonrpc: "2.0", id: rpc.id, result: decorateResult(rpc.method ?? "", reply.result ?? {}) };
  } finally {
    await clientSide.close();
  }
}
