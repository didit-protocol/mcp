# Architecture

The server ships as one codebase with **two entrypoints** that share the same tool definitions and dispatch logic (`src/index.ts`).

| Entrypoint | Mode | Transport | Auth |
|------------|------|-----------|------|
| `dist/http.js` | Hosted | Streamable HTTP (Express) | OAuth 2.1 Bearer, validated by introspection |
| `dist/index.js` | stdio (headless) | MCP stdio | user Bearer via `DIDIT_ACCESS_TOKEN` |

Both modes authenticate as a Didit **user** with a Bearer access token. There is **no API-key path**: every tool targets the user-scoped console endpoints, which reject `x-api-key`.

## Per-request credential context

A tool must authenticate as the *current caller* without changing any tool signature. This is done with an `AsyncLocalStorage` store (`requestContext` in `src/config.ts`):

- **Hosted:** the Bearer middleware validates the token and runs the dispatch inside `requestContext.run({ accessToken, organizationId }, …)`.
- **stdio:** the Bearer is supplied via the `DIDIT_ACCESS_TOKEN` env var (and optional `MCP_DEFAULT_ORG`/`MCP_DEFAULT_APP`).

The shared header builder (`getHeaders()`) sets the Bearer token (+ `X-Didit-Organization-Id`); with no Bearer it sends no auth (the request fails clearly). Every tool calls Didit through `apiRequest()`, so neither tool code nor signatures change between modes.

## OAuth (hosted)

The hosted server is an OAuth **resource server**; the **Didit Business Console** (`business.didit.me`) is the **authorization server**.

```
client → /mcp (401 + WWW-Authenticate)
client → /.well-known/oauth-protected-resource   (discovers the auth server)
client → console /authorize (PKCE)  → user logs in + consents
client → console token endpoint     → access_token (+ refresh_token)
client → /mcp  (Authorization: Bearer …)
server → auth introspection (RFC 7662, HTTP Basic with MCP_OAUTH_CLIENT_ID/SECRET)
       → { active, scope, organization_id }  → requestContext
```

Token verification is pluggable: `introspection` (default, opaque tokens) or `jwks` (`src/auth/verifier.ts`). Clients that support Dynamic Client Registration self-register with the console — nothing to pre-provision.

## Org / app resolution

The Didit management API is scoped per application (`/organization/{org}/application/{app}/…`). `src/orgapp.ts` resolves scope:

- Single org+app → resolved automatically.
- Multiple apps → the `*_search` tools and `didit_analytics` fan out across all of them (bounded concurrency, results tagged with org/app).
- Per-app `*_list` tools auto-span every app when no scope is given.

## Environment variables

| Variable | Mode | Default | Purpose |
|----------|------|---------|---------|
| `DIDIT_ACCESS_TOKEN` | stdio | — | User Bearer access token (headless stdio mode). |
| `DIDIT_API_BASE_URL` | both | `https://verification.didit.me/v3` | Verification API base. |
| `DIDIT_AUTH_BASE_URL` | both | `https://apx.didit.me/auth/v2` | Auth API base. |
| `MCP_PORT` | hosted | `3000` | HTTP listen port. |
| `MCP_RESOURCE_URI` | hosted | `https://mcp.didit.me` | Public URL of this resource server. |
| `MCP_AUTHORIZATION_SERVER_ORIGIN` | hosted | `https://business.didit.me` | Authorization server origin. |
| `MCP_TOKEN_VERIFY_MODE` | hosted | `introspection` | `introspection` or `jwks`. |
| `MCP_OAUTH_INTROSPECT_URL` | hosted | `https://apx.didit.me/auth/v2/introspect/` | RFC 7662 endpoint. |
| `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET` | hosted | — | Basic-auth credentials for introspection. |
| `MCP_SCOPES_SUPPORTED` | hosted | `didit:management didit:verification` | Scopes advertised in metadata. |
| `MCP_DEFAULT_ORG` / `MCP_DEFAULT_APP` | both | — | Auto-fill scope for single-tenant deployments. |

See [`.env.example`](.env.example) for a copyable template.

## Source layout

```
src/
  index.ts        tool definitions + dispatch + createServer()
  http.ts         Express resource server (CORS, metadata, Bearer middleware)
  config.ts       env config, requestContext (AsyncLocalStorage), apiRequest()
  security.ts     error sanitization, input/file validation
  orgapp.ts       org/app discovery + cross-app fan-out
  dates.ts        relative-date helpers
  auth/           token verifiers (introspection, jwks)
  tools/          one module per domain (sessions, settings, users, workflows, …)
```
