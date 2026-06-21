import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import {
  DIDIT_AUTH_ISSUER,
  DIDIT_JWKS_URL,
  MCP_OAUTH_CLIENT_ID,
  MCP_RESOURCE_URI,
} from "../config";

/**
 * Resource-server token verifier for the hosted MCP. Validates the user Bearer
 * JWT minted by service-didit-auth using its published JWKS (signature + expiry),
 * and — when configured — the issuer and audience. The verification API remains
 * the authoritative org-permission enforcer (via introspection); this is the fast
 * gate that produces the 401/403 challenge and the per-request AuthInfo.
 *
 * Validation is intentionally lenient on issuer/audience so it keeps working
 * through the RFC 8707 rollout: those checks only apply once the corresponding
 * env vars are set. Signature and expiry are always enforced.
 */
export class DiditTokenVerifier implements OAuthTokenVerifier {
  // Tokens are ECDSA-signed via AWS KMS (ES256) in prod and ES256 locally; auth
  // settings also reference RS256. Allow both rather than hardcoding one.
  private readonly algorithms = ["ES256", "RS256"];
  private readonly jwks = createRemoteJWKSet(new URL(DIDIT_JWKS_URL));

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const audience = [MCP_RESOURCE_URI, MCP_OAUTH_CLIENT_ID].filter(Boolean);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        algorithms: this.algorithms,
        ...(DIDIT_AUTH_ISSUER ? { issuer: DIDIT_AUTH_ISSUER } : {}),
        ...(audience.length ? { audience } : {}),
      }));
    } catch (err) {
      // jose throws on malformed/expired/bad-signature/wrong-aud tokens. Surface
      // them as InvalidTokenError so the bearer middleware answers 401 (not 500).
      if (err instanceof OAuthError) throw err;
      throw new InvalidTokenError(err instanceof Error ? err.message : "Invalid access token");
    }

    const scopes = extractScopes(payload);
    const organizationId =
      (payload.organization_id as string | undefined) ?? (payload.org as string | undefined);

    return {
      token,
      clientId: coerceClientId(payload),
      scopes,
      expiresAt: payload.exp,
      resource: new URL(MCP_RESOURCE_URI),
      extra: {
        organization_id: organizationId,
        sub: payload.sub,
        identifier: payload.identifier,
        has_2fa_enabled: payload.has_2fa_enabled === true,
      },
    };
  }
}

/** Didit tokens carry permissions under `claims` and/or `org_permissions`; both may be a list or a space-delimited string. */
function extractScopes(payload: JWTPayload): string[] {
  const out = new Set<string>();
  for (const key of ["claims", "org_permissions", "scope", "scopes"]) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") out.add(v);
    } else if (typeof value === "string") {
      for (const v of value.split(/\s+/)) if (v) out.add(v);
    }
  }
  return [...out];
}

function coerceClientId(payload: JWTPayload): string {
  if (typeof payload.client_id === "string") return payload.client_id;
  if (typeof payload.aud === "string") return payload.aud;
  if (Array.isArray(payload.aud) && typeof payload.aud[0] === "string") return payload.aud[0];
  return MCP_OAUTH_CLIENT_ID || "unknown";
}
