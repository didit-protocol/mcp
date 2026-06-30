# Didit MCP Server

Run KYC, KYB, AML, fraud screening, transaction monitoring, and workspace operations from any MCP-compatible AI client.

This is the official [Model Context Protocol](https://modelcontextprotocol.io) server for [Didit](https://didit.me), infrastructure for identity and fraud. It lets AI agents create verification sessions, run identity and business checks, screen wallets and transactions, manage workflows, review cases, export reports, and operate a Didit workspace with the same permissions as the signed-in user.

Hosted MCP endpoint:

```text
https://mcp.didit.me/mcp
```

Public docs:

- Overview: https://docs.didit.me/integration/mcp/overview
- Installation: https://docs.didit.me/integration/mcp/installation
- Tool reference: https://docs.didit.me/integration/mcp/tools

## What You Can Do

- **KYC / user verification:** create verification sessions, retrieve decisions, review ID verification, liveness, face match, proof of address, AML, and IP/device checks.
- **KYB / business verification:** search business registries, retrieve company records, review officers and ultimate beneficial owners, and start linked KYC sessions for UBOs.
- **AML screening:** screen people and companies for sanctions, PEP, adverse media, and ongoing monitoring workflows.
- **Transaction monitoring:** create and review transactions, triage flagged activity, manage remediation flows, and investigate suspicious behavior.
- **Wallet screening:** screen crypto wallets for sanctions exposure, high-risk counterparties, and fraud risk.
- **Workflow management:** create, update, validate, publish, and inspect verification workflows with branching, questionnaires, and webhooks.
- **Investigation management:** create and manage cases, assign reviews, escalate issues, reopen cases, export evidence, and prepare reports.
- **Lists and risk controls:** manage blocklists, allowlists, custom lists, and face entries.
- **Workspace operations:** manage organizations, applications, members, roles, webhooks, branding, audit logs, billing, balance, and API keys.

## Example Prompts

```text
Create a KYC session for vendor user customer-123 and return the verification link.
```

```text
Open the sessions in review, group them by risk reason, and summarize which ones need manual action.
```

```text
Search for Acme Ltd in the UK registry, show officers and beneficial owners, and start linked KYC for each UBO.
```

```text
Run AML screening on Jane Doe, born 1990, nationality ES, and summarize any matches.
```

```text
Screen this wallet address before withdrawal and summarize sanctions or high-risk exposure.
```

```text
Create a transaction, screen it for fraud risk, and tell me whether it should be escalated.
```

```text
Open a case for this flagged transaction, assign it to compliance, and export the evidence.
```

```text
Create a workflow with ID verification, passive liveness, face match, AML screening, and a webhook callback.
```

```text
Show my organization balance, monthly usage, active applications, members, and webhook destinations.
```

## Quick Start

### Hosted Endpoint

No install and no API key. Point your MCP client at the hosted URL and sign in with Didit:

```text
https://mcp.didit.me/mcp
```

### Claude Code

```bash
claude mcp add --transport http didit https://mcp.didit.me/mcp
```

Then run:

```bash
claude /mcp
```

### Cursor

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "didit": {
      "url": "https://mcp.didit.me/mcp"
    }
  }
}
```

### VS Code

Add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "didit": {
      "type": "http",
      "url": "https://mcp.didit.me/mcp"
    }
  }
}
```

### ChatGPT / OpenAI Remote MCP

Use server URL `https://mcp.didit.me/mcp` with OAuth authentication.

### Windsurf / Zed

Use `mcp-remote` if the client needs a local stdio bridge:

```json
{
  "mcpServers": {
    "didit": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://mcp.didit.me/mcp"]
    }
  }
}
```

## Authentication

The hosted MCP server uses OAuth 2.1 with PKCE:

1. Your MCP client opens the Didit login page.
2. You log in with Didit and approve the requested scopes.
3. The MCP acts as your signed-in Didit user.
4. Didit enforces your existing organization role and permissions on every call.

Scopes:

- `didit:verification` for sessions, decisions, standalone checks, users, businesses, transactions, and screening.
- `didit:management` for workflows, webhooks, members, billing, cases, lists, reports, and workspace settings.

There is no hosted API-key setup. Hosted MCP calls use OAuth Bearer tokens for the signed-in user, not application `x-api-key` credentials. If you want backend-to-backend REST integration with application API keys, use the [Didit API docs](https://docs.didit.me) directly.

## Tool Areas

The MCP server exposes tools for:

- Context and organization discovery.
- Sessions, decisions, reviews, imports, PDFs, status updates, and shared sessions.
- Vendor users and vendor businesses.
- Standalone verification APIs for ID, AML, KYB, proof of address, database validation, liveness, face match, face search, age, email, and phone.
- Workflows, workflow drafts, graph editing, graph validation, branching fields, and publishing.
- Transaction monitoring, wallet screening, cases, alerts, reports, audit logs, blocklists, allowlists, and custom lists.
- Questionnaires, webhooks, members, roles, API keys, billing, balance, and branding.

For the full tool list with read/write/destructive annotations, see [`docs/TOOLS.md`](docs/TOOLS.md) or https://docs.didit.me/integration/mcp/tools.

## Self-Host

The hosted server is recommended. To self-host:

```bash
git clone https://github.com/didit-protocol/mcp.git
cd mcp

# Docker
cp .env.example .env
docker build -t didit-mcp .
docker run -p 3000:3000 --env-file .env didit-mcp

# Node
npm install
npm run build
node dist/http.js
```

For headless stdio runs:

```bash
DIDIT_ACCESS_TOKEN=<user-access-token> node dist/index.js
```

Self-hosted deployments still authenticate as a Didit user. There is no application API-key mode for MCP tools.

## Registry Metadata

This repository includes:

- [`server.json`](server.json) for the official MCP Registry and downstream MCP directories.
- [`llms-install.md`](llms-install.md) for coding agents and marketplaces that validate one-click setup from repository instructions.

Hosted registry listings should use:

- Server URL: `https://mcp.didit.me/mcp`
- Transport: Streamable HTTP
- Authentication: OAuth
- Repository: `https://github.com/didit-protocol/mcp`

Do not list `DIDIT_API_KEY` as a required hosted-server environment variable.

## Documentation

- Didit website: https://didit.me
- Didit docs: https://docs.didit.me
- MCP overview: https://docs.didit.me/integration/mcp/overview
- MCP installation: https://docs.didit.me/integration/mcp/installation
- MCP authentication: https://docs.didit.me/integration/mcp/authentication
- MCP tool reference: https://docs.didit.me/integration/mcp/tools

## Contributing

Issues and PRs are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Didit Protocol
