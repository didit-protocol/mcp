#!/usr/bin/env node
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

import { createServer, SERVER_VERSION } from "./index";
import { DiditTokenVerifier } from "./auth/verifier";
import { IntrospectionTokenVerifier } from "./auth/introspection-verifier";
import {
  MCP_PORT,
  MCP_RESOURCE_URI,
  MCP_SCOPES_SUPPORTED,
  MCP_TOKEN_VERIFY_MODE,
  DIDIT_AUTH_ISSUER,
  DIDIT_OIDC_DISCOVERY_URL,
  DIDIT_OIDC_AUTHORIZE_URL,
  DIDIT_OIDC_TOKEN_URL,
  DIDIT_OIDC_REGISTRATION_URL,
  DIDIT_JWKS_URL,
} from "./config";

/**
 * Resolve the upstream Authorization Server (service-didit-auth) metadata that we
 * advertise to MCP clients. Prefer the live discovery document so the real
 * endpoints are authoritative; fall back to config-derived values if it is
 * unreachable at boot.
 */
async function resolveAuthorizationServerMetadata(): Promise<OAuthMetadata> {
  const fallback: OAuthMetadata = {
    // The authorization server's issuer may be path-scoped (e.g. .../auth), so prefer the
    // explicit DIDIT_AUTH_ISSUER; only fall back to the authorize URL's origin if unset.
    issuer: DIDIT_AUTH_ISSUER || new URL(DIDIT_OIDC_AUTHORIZE_URL).origin,
    authorization_endpoint: DIDIT_OIDC_AUTHORIZE_URL,
    token_endpoint: DIDIT_OIDC_TOKEN_URL,
    registration_endpoint: DIDIT_OIDC_REGISTRATION_URL,
    jwks_uri: DIDIT_JWKS_URL,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: MCP_SCOPES_SUPPORTED,
  };

  try {
    const res = await fetch(DIDIT_OIDC_DISCOVERY_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`discovery ${res.status}`);
    const doc = (await res.json()) as Partial<OAuthMetadata>;
    if (doc.authorization_endpoint && doc.token_endpoint) {
      return { ...fallback, ...doc } as OAuthMetadata;
    }
    console.error(`[didit-mcp] discovery doc missing endpoints, using fallback`);
  } catch (err) {
    console.error(`[didit-mcp] could not fetch ${DIDIT_OIDC_DISCOVERY_URL}: ${String(err)} — using fallback`);
  }
  return fallback;
}

async function main(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // CORS so browser-based MCP clients (MCP Inspector, the Claude web connector, etc.)
  // can reach /mcp and the discovery endpoints cross-origin. MCP authenticates with a
  // Bearer token (no cookies), so reflecting the request origin is safe. The OPTIONS
  // preflight is answered here — before requireBearerAuth — so it isn't rejected as 401.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", (req.headers.origin as string) || "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, mcp-protocol-version, mcp-session-id, last-event-id",
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  const resourceServerUrl = new URL(MCP_RESOURCE_URI);
  const oauthMetadata = await resolveAuthorizationServerMetadata();

  // RFC 9728 Protected Resource Metadata + advertises the upstream AS (RS-only).
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl,
      scopesSupported: MCP_SCOPES_SUPPORTED,
      resourceName: "Didit MCP",
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "didit-mcp-server", version: SERVER_VERSION });
  });

  // Emits 401 + WWW-Authenticate (pointing at the protected-resource metadata)
  // for unauthenticated calls, and populates req.auth on success.
  // Default to introspection: the auth service's OIDC flow issues opaque tokens
  // that cannot be validated locally. JWKS is available for JWT-access-token setups.
  const verifier =
    MCP_TOKEN_VERIFY_MODE === "jwks" ? new DiditTokenVerifier() : new IntrospectionTokenVerifier();
  console.error(`[didit-mcp] token verification mode: ${MCP_TOKEN_VERIFY_MODE}`);
  const bearerAuth = requireBearerAuth({
    verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  // Stateless Streamable HTTP: a fresh server + transport per request avoids
  // JSON-RPC id collisions across concurrent clients and needs no ALB affinity.
  app.post("/mcp", bearerAuth, async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      // req.auth (set by requireBearerAuth) is forwarded by the transport into
      // each request's RequestHandlerExtra.authInfo, where the dispatch reads it.
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[didit-mcp] request error: ${String(err)}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode does not support server-initiated streams or session teardown.
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: stateless server only accepts POST /mcp" },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(MCP_PORT, () => {
    console.error(`Didit MCP Server v${SERVER_VERSION} (HTTP/OAuth) on :${MCP_PORT}, resource=${MCP_RESOURCE_URI}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
