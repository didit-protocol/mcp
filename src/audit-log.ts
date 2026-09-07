// One structured line per tools/call, so the log pipeline (stderr → Loki) can answer
// "who ran which tool, against which org, with what outcome" — the MCP server's own
// audit record, complementary to the backend's HTTP audit log (which sees the request
// but not the tool name). Argument VALUES are never logged (PII): only their keys and
// a canonical digest, which is enough to correlate a call with the exact payload.
import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export interface ToolCallMeta {
  tool: string;
  args: Record<string, unknown>;
  authInfo?: AuthInfo;
  hosted: boolean;
  /** Shadow-mode verdict of the permission pre-check (permissions.ts), when it would have denied. */
  permissionCheck?: "would_deny";
}

export interface ToolResultLike {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

/** Deterministic JSON: object keys sorted recursively, so key order never changes the digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);

  return `{${entries.join(",")}}`;
}

export function argsDigest(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex").slice(0, 16);
}

/** Our own error format is `Error [code]: …` (see the dispatch catch); recover the code. */
function errorCodeOf(result: ToolResultLike): string | undefined {
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";

  return /^Error \[([a-z_]+)\]/.exec(text)?.[1] ?? "tool_error";
}

function extra(authInfo: AuthInfo | undefined, key: string): string | undefined {
  const value = (authInfo?.extra as Record<string, unknown> | undefined)?.[key];

  return typeof value === "string" ? value : undefined;
}

function record(meta: ToolCallMeta, startedAt: number, outcome: "ok" | "error", errorCode?: string) {
  return {
    time: new Date().toISOString(),
    level: "info",
    event: "mcp.tool_call",
    tool: meta.tool,
    outcome,
    ...(errorCode ? { error_code: errorCode } : {}),
    duration_ms: Date.now() - startedAt,
    transport: meta.hosted ? "hosted" : "stdio",
    sub: extra(meta.authInfo, "sub"),
    organization_id: extra(meta.authInfo, "organization_id"),
    client_id: meta.authInfo?.clientId,
    args_digest: argsDigest(meta.args),
    arg_keys: Object.keys(meta.args).sort(),
    ...(typeof meta.args.confirm === "boolean" ? { confirm: meta.args.confirm } : {}),
    ...(meta.permissionCheck ? { permission_check: meta.permissionCheck } : {}),
  };
}

/** stderr on purpose: over stdio, stdout is the JSON-RPC channel. Never throws. */
function emit(meta: ToolCallMeta, startedAt: number, outcome: "ok" | "error", errorCode?: string): void {
  try {
    console.error(JSON.stringify(record(meta, startedAt, outcome, errorCode)));
  } catch (error) {
    console.error(`[didit-mcp] audit log failed for ${meta.tool}: ${(error as Error).message}`);
  }
}

/** Run one tool dispatch and log its outcome, whether it returned, errored, or threw. */
export async function auditToolCall<T extends ToolResultLike>(meta: ToolCallMeta, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();

  try {
    const result = await run();

    emit(meta, startedAt, result.isError ? "error" : "ok", result.isError ? errorCodeOf(result) : undefined);

    return result;
  } catch (error) {
    emit(meta, startedAt, "error", "exception");
    throw error;
  }
}
