#!/usr/bin/env node
import express from "express";
import { downloadSessionPdf, SESSION_PDF_DOWNLOAD_PATH } from "./session-pdf-download";
import { downloadSessionSignatureFile, SESSION_SIGNATURE_DOWNLOAD_PATH } from "./signature-download";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

import { createServer } from "./index";
import { compressResponses } from "./compress";
import { apiKeyScopeOf } from "./api-key-connection";
import { defaultToolsets, selectionFromRequest } from "./toolsets";
import { modernGate, isModernRequest, handleModernRpc } from "./mcp-modern";
import { mountDomainChallenge, mountProfileEndpoint, mountWidgetFonts, type CatalogProfile } from "./chatgpt-app";
import { mountInvestigatorAgentEndpoint } from "./investigator-agent";
import { DiditTokenVerifier } from "./auth/verifier";
import { IntrospectionTokenVerifier } from "./auth/introspection-verifier";
import { CachingTokenVerifier } from "./auth/cached-verifier";
import {MCP_PORT,
  MCP_RESOURCE_URI,
  MCP_SCOPES_SUPPORTED,
  MCP_TOKEN_VERIFY_MODE,
  MCP_INTROSPECTION_CACHE_TTL_MS,
  DIDIT_AUTH_ISSUER,
  DIDIT_OIDC_DISCOVERY_URL,
  DIDIT_OIDC_AUTHORIZE_URL,
  DIDIT_OIDC_TOKEN_URL,
  DIDIT_OIDC_REGISTRATION_URL,
  DIDIT_JWKS_URL, SERVER_VERSION,
  MCP_PUBLIC_DISCOVERY,
  MCP_PAYMENTS_PATH,
  SERVER_FEATURES } from "./config";

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

/**
 * The only JSON-RPC methods MCP_PUBLIC_DISCOVERY exposes without a Bearer: protocol
 * negotiation and its acknowledgement. Deliberately NOT `tools/list` - the catalog is the
 * thing the OAuth gate protects, and a public catalog is exactly what the 2026-09 app review
 * work removed from this server.
 */
const PUBLIC_DISCOVERY_METHODS = new Set(["initialize", "notifications/initialized", "server/discover"]);

export async function createHttpApp(): Promise<express.Express> {
  const app = express();
  // First, so every answer below can go out compressed (compress.ts).
  app.use(...compressResponses());
  // This narrowly scoped capability URL authenticates itself; no MCP Bearer required.
  app.get(SESSION_PDF_DOWNLOAD_PATH, downloadSessionPdf);
  app.get(SESSION_SIGNATURE_DOWNLOAD_PATH, downloadSessionSignatureFile);
  // Base64 file inputs (*_base64 tool params, 15MB decoded cap + ~33% base64
  // overhead) must fit in the JSON-RPC body. Overridable per environment.
  app.use(express.json({ limit: process.env.MCP_JSON_BODY_LIMIT || "25mb" }));

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
      "Authorization, Content-Type, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id, x-mcp-toolsets, x-mcp-readonly, x-api-key",
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  mountDomainChallenge(app);
  mountWidgetFonts(app);
  // The Investigator's remote engine: authenticated by a run token the backend verifies, not by OAuth.
  mountInvestigatorAgentEndpoint(app);

  const resourceServerUrl = new URL(MCP_RESOURCE_URI);
  const oauthMetadata = await resolveAuthorizationServerMetadata();
  const protectedResourceMetadata = {
    resource: resourceServerUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: MCP_SCOPES_SUPPORTED,
    resource_name: "Didit MCP",
  };

  // RFC 9728 Protected Resource Metadata + advertises the upstream AS (RS-only).
  // The MCP SDK serves the canonical path-specific metadata URL when the
  // resource has a path (`/.well-known/oauth-protected-resource/mcp`). Keep the
  // origin-root URL as a compatibility alias because VS Code probes it first.
  if (resourceServerUrl.pathname !== "/") {
    app.get("/.well-known/oauth-protected-resource", (_req, res) => {
      res.json(protectedResourceMetadata);
    });
  }
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl,
      scopesSupported: MCP_SCOPES_SUPPORTED,
      resourceName: "Didit MCP",
    }),
  );

  // The unlisted agent payments endpoint: the full catalog plus didit_org_top_up. Same authorization
  // server, scopes and tokens as /mcp; its own protected resource (RFC 9728) so a client asks for a
  // token for this resource. Never submitted to a directory. Lives here, not in chatgpt-app.ts,
  // so the open-source build serves it too.
  const paymentsResourceUrl = new URL(MCP_PAYMENTS_PATH, resourceServerUrl);
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: paymentsResourceUrl,
      scopesSupported: MCP_SCOPES_SUPPORTED,
      resourceName: "Didit MCP (agent payments)",
    }),
  );

  // A reduced catalog profile may be a second protected resource on the same server (see chatgpt-app.ts).
  const profileEndpoint = mountProfileEndpoint(app, { oauthMetadata, resourceServerUrl, scopesSupported: MCP_SCOPES_SUPPORTED });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "didit-mcp-server", version: SERVER_VERSION, features: SERVER_FEATURES });
  });

  // Emits 401 + WWW-Authenticate (pointing at the protected-resource metadata)
  // for unauthenticated calls, and populates req.auth on success.
  // Default to introspection: the auth service's OIDC flow issues opaque tokens
  // that cannot be validated locally. JWKS is available for JWT-access-token setups.
  // Introspection is a network call per request, so accepted tokens are remembered briefly
  // (auth/cached-verifier.ts); JWKS verification is local and needs no cache.
  const verifier =
    MCP_TOKEN_VERIFY_MODE === "jwks"
      ? new DiditTokenVerifier()
      : new CachingTokenVerifier(new IntrospectionTokenVerifier(), MCP_INTROSPECTION_CACHE_TTL_MS);
  console.error(`[didit-mcp] token verification mode: ${MCP_TOKEN_VERIFY_MODE}`);
  // One endpoint per catalog profile. Each is its own OAuth protected resource, so its 401
  // challenge points at its own metadata URL and the client requests a token for the right
  // resource indicator. The dispatch is identical apart from the profile handed to the server.
  // `moneyTools` is the one explicit money gate (index.ts createServer): false everywhere except
  // the unlisted payments endpoint, so the directory-listed /mcp and /mcp/chatgpt never move money.
  const endpoints: Array<{ path: string; profile: CatalogProfile; resourceUrl: URL; moneyTools: boolean }> = [
    { path: "/mcp", profile: "full", resourceUrl: resourceServerUrl, moneyTools: false },
    ...(profileEndpoint ? [{ ...profileEndpoint, moneyTools: false }] : []),
    { path: MCP_PAYMENTS_PATH, profile: "full", resourceUrl: paymentsResourceUrl, moneyTools: true },
  ];

  // Stateless mode does not support server-initiated streams or session teardown.
  const methodNotAllowed = (path: string) => (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Method not allowed: stateless server only accepts POST ${path}` },
      id: null,
    });
  };

  for (const endpoint of endpoints) {
    // Emits 401 + WWW-Authenticate (pointing at this resource's protected-resource metadata)
    // for unauthenticated calls, and populates req.auth on success.
    const bearerAuth = requireBearerAuth({
      verifier,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(endpoint.resourceUrl),
    });

    // Mixed auth (config.ts MCP_PUBLIC_DISCOVERY, off by default): let the protocol-negotiation
    // methods through without a Bearer and require one for everything else. A client cannot know
    // how to authenticate until it has negotiated a protocol version, so hosts that probe with
    // `server/discover` first read an unconditional 401 as "cannot connect" rather than as an
    // OAuth challenge. These three methods disclose only the server name, version, capabilities
    // and supported versions; the tool catalog and every tool call stay behind `bearerAuth`.
    // A batched (array) body has no top-level `method`, so it always takes the authenticated path.
    const maybeBearerAuth: express.RequestHandler = (req, res, next) => {
      if (MCP_PUBLIC_DISCOVERY) {
        const method = (req.body as { method?: unknown } | undefined)?.method;
        if (typeof method === "string" && PUBLIC_DISCOVERY_METHODS.has(method)) return next();
      }
      // An application API key (api-key-connection.ts) may come in the header the Didit API
      // itself uses. It is verified exactly like one sent as a Bearer; an Authorization header,
      // when both are present, wins.
      const apiKey = req.headers["x-api-key"];
      if (!req.headers.authorization && typeof apiKey === "string" && apiKey.trim()) {
        req.headers.authorization = `Bearer ${apiKey.trim()}`;
      }

      return bearerAuth(req, res, next);
    };
    // API keys connect to the full catalog only. A reduced profile is a reviewed app with its own
    // sign-in (the ChatGPT app), and its data boundary is defined for a person's connection.
    const keyOnlyOnFullProfile: express.RequestHandler = (req, res, next) => {
      if (endpoint.profile === "full" || !apiKeyScopeOf(req.auth)) return next();
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "This endpoint takes a sign-in with Didit. Connect an API key to /mcp instead." },
        id: null,
      });
    };

    // Stateless Streamable HTTP: a fresh server + transport per request avoids
    // JSON-RPC id collisions across concurrent clients and needs no ALB affinity.
    app.post(endpoint.path, maybeBearerAuth, keyOnlyOnFullProfile, async (req, res) => {
      // MCP 2026-07-28 dual-era dispatch: modern requests pin their protocol
      // version on every message and skip the initialize handshake; anything
      // else takes the legacy Streamable HTTP transport below, unchanged.
      const rpc = req.body ?? {};
      const gateError = modernGate(rpc, req.headers);
      // What this connection asked to load (toolsets.ts): `?toolsets=core,transactions&read_only=true`
      // on the server URL, or the X-MCP-Toolsets / X-MCP-Readonly headers. Read from the request on
      // every call, because the server is stateless: there is no session to remember it in.
      const selection = selectionFromRequest(req.query, req.headers, defaultToolsets());

      if (gateError) {
        res.status(400).json({ jsonrpc: "2.0", error: gateError, id: rpc.id ?? null });
        return;
      }
      if (isModernRequest(rpc, req.headers)) {
        try {
          const reply = await handleModernRpc(rpc, req.auth, {
            profile: endpoint.profile,
            moneyTools: endpoint.moneyTools,
            selection,
          });
          if (reply) res.json(reply);
          else res.status(202).end();
        } catch (err) {
          console.error(`[didit-mcp] modern request error: ${String(err)}`);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: rpc.id ?? null,
            });
          }
        }
        return;
      }

      const server = createServer({
        hosted: true,
        profile: endpoint.profile,
        moneyTools: endpoint.moneyTools,
        selection,
        // What the server says about itself depends on who connected (guidance.ts).
        apiKey: Boolean(apiKeyScopeOf(req.auth)),
      });
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

    app.get(endpoint.path, methodNotAllowed(endpoint.path));
    app.delete(endpoint.path, methodNotAllowed(endpoint.path));
  }

  // Body-parser failures happen before any MCP route runs, and Express's default handler
  // answers HTML. An MCP client parses only JSON-RPC, so a malformed or oversized body must
  // come back in the protocol's own shape (JSON-RPC Parse error / Invalid Request), exactly
  // like the empty-body case the transport already answers. Anything else falls through.
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: Invalid JSON" } });
      return;
    }
    if (err?.type === "entity.too.large") {
      res.status(413).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: request body exceeds the configured size limit" },
      });
      return;
    }
    // Any other body-parser rejection (unsupported charset/encoding) is still the client's
    // request being invalid, so it keeps the protocol's envelope and status too.
    if (typeof err?.type === "string" && /^(entity|charset|encoding)\./.test(err.type) && typeof err.status === "number") {
      res.status(err.status).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: the request body could not be read" },
      });
      return;
    }
    return next(err);
  });

  return app;
}

async function main(): Promise<void> {
  const app = await createHttpApp();

  app.listen(MCP_PORT, () => {
    console.error(`Didit MCP Server v${SERVER_VERSION} (HTTP/OAuth) on :${MCP_PORT}, resource=${MCP_RESOURCE_URI}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
