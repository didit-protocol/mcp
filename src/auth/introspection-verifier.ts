import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import {
  MCP_OAUTH_INTROSPECT_URL,
  MCP_OAUTH_CLIENT_ID,
  MCP_OAUTH_CLIENT_SECRET,
  MCP_RESOURCE_URI,
  MCP_DEFAULT_ORG,
} from "../config";

/**
 * RFC 7662 token-introspection verifier — the correct path for service-didit-auth,
 * whose OIDC authorization-code flow issues opaque access tokens. Mirrors the contract
 * the verification service already uses (POST {token, requested_org} with the client's
 * Basic auth) so the same auth backend validates MCP and API calls identically.
 *
 * Introspection returns the org-scoped permissions directly, so this also yields the
 * scopes and organization_id the dispatch needs — no second call.
 */
export class IntrospectionTokenVerifier implements OAuthTokenVerifier {
  private readonly basic = "Basic " + Buffer.from(`${MCP_OAUTH_CLIENT_ID}:${MCP_OAUTH_CLIENT_SECRET}`).toString("base64");

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const body: Record<string, string> = { token };
    if (MCP_DEFAULT_ORG) body.requested_org = MCP_DEFAULT_ORG;

    let data: Record<string, unknown> | null = null;
    try {
      const res = await fetch(MCP_OAUTH_INTROSPECT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: this.basic },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) data = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw new InvalidTokenError(`Introspection request failed: ${String(err)}`);
    }

    // RFC 7662: `active` is REQUIRED and authoritative. Treat anything other than an
    // explicit true (including a response that omits the field) as inactive.
    if (!data || data.active !== true) {
      throw new InvalidTokenError("Token is inactive or unknown");
    }
    const exp = typeof data.exp === "number" ? data.exp : undefined;
    if (exp !== undefined && exp * 1000 <= Date.now()) {
      throw new InvalidTokenError("Token has expired");
    }

    const scopes = coerceList(data.org_permissions).concat(coerceList(data.claims), coerceList(data.scope));
    const organizationId =
      (data.organization_id as string | undefined) ||
      (data.requested_org as string | undefined) ||
      MCP_DEFAULT_ORG ||
      undefined;

    return {
      token,
      clientId: (data.client_id as string) || (data.aud as string) || MCP_OAUTH_CLIENT_ID || "unknown",
      scopes: [...new Set(scopes)],
      expiresAt: exp,
      resource: new URL(MCP_RESOURCE_URI),
      extra: {
        organization_id: organizationId,
        sub: data.sub ?? data.user_id,
        identifier: data.identifier,
        has_2fa_enabled: data.has_2fa_enabled === true,
      },
    };
  }
}

function coerceList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}
