import { createHash } from "node:crypto";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Remembers an ACCEPTED access token for a short while, so a burst of MCP
 * requests from one client costs one introspection instead of one per request.
 *
 * Why: the hosted MCP is stateless, so every JSON-RPC message (`initialize`,
 * `notifications/initialized`, `tools/list`, each tool call) is its own
 * authenticated POST, and each POST introspected the token at
 * service-didit-auth. In production on 2026-11-03 that introspection took
 * p50 ~1.7 s around the busy 10-minute marks (about 0.05 s otherwise), and
 * every MCP request waited on it. Ask Didit's tool listing (three such
 * requests for a new connection) then ran past its 4 s budget on both
 * attempts 27 times on 2 and 3 November, and the user got a turn without
 * Didit tools.
 *
 * - Only successes are cached. A rejected token, and an auth service that did
 *   not answer, are never remembered: the next request asks again.
 * - An entry lives at most `ttlMs`, and never past the token's own expiry.
 * - Revocation lag is bounded by `ttlMs`: a revoked token can keep reaching the
 *   MCP for at most that long, and every Didit API call a tool makes still
 *   re-checks the token at the API itself.
 * - Concurrent requests for one token share a single in-flight introspection.
 * - Keys are SHA-256 hashes, so the process never keeps raw tokens as keys,
 *   and the map is bounded (oldest entry out first).
 */
export class CachingTokenVerifier implements OAuthTokenVerifier {
  private readonly entries = new Map<string, { info: AuthInfo; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<AuthInfo>>();

  constructor(
    private readonly inner: OAuthTokenVerifier,
    private readonly ttlMs: number,
    private readonly maxEntries = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.ttlMs <= 0) return this.inner.verifyAccessToken(token);

    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) return copyOf(hit.info);
    if (hit) this.entries.delete(key);

    const pending = this.inflight.get(key);
    if (pending) return copyOf(await pending);

    const verifying = this.inner.verifyAccessToken(token);
    this.inflight.set(key, verifying);
    try {
      const info = await verifying;
      this.remember(key, info);
      return copyOf(info);
    } finally {
      this.inflight.delete(key);
    }
  }

  private remember(key: string, info: AuthInfo): void {
    const now = this.now();
    const tokenExpiry = typeof info.expiresAt === "number" ? info.expiresAt * 1000 : Infinity;
    const expiresAt = Math.min(now + this.ttlMs, tokenExpiry);
    if (expiresAt <= now) return;
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { info, expiresAt });
  }
}

/** Each request gets its own object, so a handler that edits its AuthInfo can
 * never change what a later request of the same token sees. */
function copyOf(info: AuthInfo): AuthInfo {
  return { ...info, scopes: [...info.scopes], ...(info.extra && { extra: { ...info.extra } }) };
}
