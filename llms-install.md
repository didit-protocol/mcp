# Didit MCP Server Install Guide for AI Agents

Use the hosted server unless the user explicitly asks to self-host.

## Hosted Endpoint

```text
https://mcp.didit.me/mcp
```

The hosted server uses OAuth 2.1 + PKCE. Users log in with Didit in the browser and approve scopes. When a person sets it up, do not ask for a Didit API key.

For an agent that runs with no person present (CI, scheduled jobs, backend agents), the hosted server also accepts an application API key in the `x-api-key` header:

```bash
claude mcp add --transport http didit https://mcp.didit.me/mcp --header "x-api-key: $DIDIT_API_KEY"
```

An API key connection is that one application, not a person, so the tools that act for a member of an organization are not listed on it.

## Claude Code

```bash
claude mcp add --transport http didit https://mcp.didit.me/mcp
```

After adding the server, run:

```bash
claude /mcp
```

Then authenticate with Didit when prompted.

## Claude plugin

`/plugin install didit --marketplace didit-protocol/skills` installs the Didit plugin (this server + 8 skills). Source: https://github.com/didit-protocol/skills/tree/main/plugins/didit

## Cursor

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

## VS Code

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

## Windsurf / Zed

Use `mcp-remote` if the client needs a local bridge:

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

## Self-hosted Docker

Use this only if the user wants to run their own server:

```bash
git clone https://github.com/didit-protocol/mcp.git
cd mcp
docker build -t didit-mcp .
docker run -p 3000:3000 --env-file .env didit-mcp
```

The self-hosted server authenticates the same way as the hosted one: a Didit sign-in, or an application API key in the `x-api-key` header. API keys need the default token verification mode (`MCP_TOKEN_VERIFY_MODE=introspection`).
