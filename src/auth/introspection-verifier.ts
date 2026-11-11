import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { apiKeyAuthInfo, looksLikeApiKey } from "../api-key-connection";
import {
  MCP_OAUTH_INTROSPECT_URL,
  MCP_OAUTH_CLIENT_ID,
  MCP_OAUTH_CLIENT_SECRET,
  MCP_RESOURCE_URI,
  MCP_DEFAULT_ORG,
  AGENT_HEADER,
  AGENT_HEADER_VALUE,
} from "../config";

/** Attempts at the auth service per verification: one retry for a timeout, a network error, a 429 or a 5xx. */
const INTROSPECTION_ATTEMPTS = 2;

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

  /**
   * The introspection answer, or null when the auth service SAID the token is not valid (a 4xx
   * other than 429).
   *
   * An auth service that does not answer is not an invalid token. Until 2026-11-04 a timeout, a
   * network error or a 5xx became `invalid_token` (401), and the assistant told the user "your
   * Didit session has expired, sign in again" in the middle of a workflow build (local first-try
   * run of the staging demo prompt: "Introspection request failed: TimeoutError"). It is retried
   * once and, if the service still does not answer, reported as a server error (500), which the
   * caller can retry, never as a reason to sign in again.
   */
  private async introspect(body: Record<string, string>): Promise<Record<string, unknown> | null> {
    let failure = "";
    for (let attempt = 1; attempt <= INTROSPECTION_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(MCP_OAUTH_INTROSPECT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: this.basic, [AGENT_HEADER]: AGENT_HEADER_VALUE },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return (await res.json()) as Record<string, unknown>;
        // service-didit-auth answers a token it refuses with a 4xx, not only with
        // `active: false`: AuthenticationFailed("Invalid token") / deleted or disabled
        // user is a 401 (authorizations/views/tokens.py). A 429 is the service
        // throttling, not a verdict on the token, so it is retried like a 5xx.
        if (res.status < 500 && res.status !== 429) return null;
        failure = `HTTP ${res.status}`;
      } catch (err) {
        failure = String(err);
      }
    }
    throw new ServerError(`Token introspection unavailable: ${failure}`);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // An application API key instead of a person's token (api-key-connection.ts): the auth
    // service introspects it under `api_key`, and the answer names its application.
    if (looksLikeApiKey(token)) {
      const answer = await this.introspect({ api_key: token });
      if (!answer || answer.active !== true) {
        throw new InvalidTokenError("API key is invalid, revoked or expired");
      }

      return apiKeyAuthInfo(token, answer, new URL(MCP_RESOURCE_URI));
    }

    const body: Record<string, string> = { token };
    if (MCP_DEFAULT_ORG) body.requested_org = MCP_DEFAULT_ORG;

    const data = await this.introspect(body);

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
        // Optional role flag from the token; the backend permission is the authoritative gate.
        // It only controls which tools the connected user can see / call (none in the OSS build).
        is_privileged: data.is_staff === true,
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
