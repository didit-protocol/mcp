# Didit MCP Server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [Didit](https://didit.me) — bring KYC, KYB, AML screening, transaction monitoring, biometrics, and full workspace operations to Claude, Cursor, VS Code, Windsurf, Zed, and any MCP client.

- **110+ tools** across sessions, workflows, vendor users/businesses, transactions, the standalone verification APIs, lists, cases, reports, webhooks, and billing.
- **Auth is "Log in with Didit" (OAuth 2.1 + PKCE)** — the MCP acts as the signed-in **user** with their role's permissions. There is **no API-key mode**: every tool calls the user-scoped console endpoints, which only accept a Bearer token.
- Every tool calls a single Didit REST endpoint and returns the JSON verbatim.

> Full documentation: **https://docs.didit.me/integration/mcp/overview**

## Quick start

### Hosted (recommended)

No install, no API key — point your client at the hosted URL and sign in via the browser:

```
https://mcp.didit.me/mcp
```

**Claude Code**

```bash
claude mcp add --transport http didit https://mcp.didit.me/mcp
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{ "mcpServers": { "didit": { "url": "https://mcp.didit.me/mcp" } } }
```

**Windsurf / Zed** (via the `mcp-remote` bridge)

```json
{ "mcpServers": { "didit": { "command": "npx", "args": ["-y", "mcp-remote@latest", "https://mcp.didit.me/mcp"] } } }
```

See [per-client setup](https://docs.didit.me/integration/mcp/installation) for Claude Desktop and VS Code.

## Authentication

The MCP is an OAuth 2.1 **resource server**; the Didit console (`business.didit.me`) is the **authorization server**. On first connect your client opens a browser, you **Log in with Didit** and approve the scopes, and the MCP then acts as **you** — across every organization you belong to, with your role's permissions. Tokens are short-lived and refreshed automatically.

Scopes: `didit:management` (workspace operations) and `didit:verification` (running checks). Your console **role** is enforced server-side on every call.

> **There is no API-key mode.** Every tool targets the user-scoped console endpoints (`/organization/{org}/application/{app}/…`), which authorize a Bearer token with per-role privileges and reject `x-api-key`. (For raw REST access with an application API key — e.g. creating sessions from your backend — use the [REST API](https://docs.didit.me) directly, not this server.)

See [Authentication](https://docs.didit.me/integration/mcp/authentication).

## Tools

110+ tools, grouped by area. The full catalogue with read/write/destructive markers is in [`docs/TOOLS.md`](docs/TOOLS.md) and at [docs.didit.me](https://docs.didit.me/integration/mcp/tools). Highlights:

- **Discovery & cross-app:** `didit_context_get`, `didit_session_search`, `didit_transaction_search`, `didit_vendor_user_search`, `didit_analytics` — aggregate across every org/app in one call.
- **Sessions:** create, list, get decision, update status, reviews, bulk import.
- **Verification APIs:** `didit_verify_id`, `didit_verify_aml`, `didit_verify_face_match`, `didit_verify_kyb_search`, …
- **Workflows (incl. branching graphs):** `didit_workflow_search`, `didit_workflow_get_graph`, `didit_workflow_edit_graph` — build conditional/branching workflows (fuzzy-match conditions, Document-AI steps) by sending small ops; large feature configs are kept server-side, never resent.
- **Compliance:** transaction monitoring, lists/blocklist/allowlist, cases, reports, audit logs, alerts.
- **Workspace:** questionnaires, webhooks, members, billing, branding.

## Run it yourself

The hosted server above is the easy path — no install. To self-host, clone this repo and run it with **Docker** or Node. It authenticates the user the same way (OAuth, or a user Bearer token for headless runs); there is no API-key mode.

```bash
git clone https://github.com/didit-protocol/mcp.git && cd mcp

# Docker (recommended) — serves /mcp and /healthz on port 3000
docker build -t didit-mcp . && docker run -p 3000:3000 --env-file .env didit-mcp

# …or with Node
npm install && npm run build
node dist/http.js                                          # hosted HTTP/OAuth
DIDIT_ACCESS_TOKEN=<user-access-token> node dist/index.js  # stdio (headless)
```

All Didit base URLs and OAuth endpoints are environment variables with public defaults (`verification.didit.me`, `apx.didit.me`, `business.didit.me`) — override them for a private deployment. See [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`.env.example`](.env.example) for the full reference.

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Run the hosted server at [`mcp.didit.me/mcp`](https://mcp.didit.me/mcp), or self-host from this repo (Docker / Node) — see [**Run it yourself**](#run-it-yourself).

## License

[MIT](LICENSE) © Didit Protocol
