# Didit MCP Server Install Guide for AI Agents

Use the hosted server unless the user explicitly asks to self-host.

## Hosted Endpoint

```text
https://mcp.didit.me/mcp
```

The hosted server uses OAuth 2.1 + PKCE. Users log in with Didit in the browser and approve scopes. Do not ask for a Didit API key for hosted setup.

## Claude Code

```bash
claude mcp add --transport http didit https://mcp.didit.me/mcp
```

After adding the server, run:

```bash
claude /mcp
```

Then authenticate with Didit when prompted.

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

The self-hosted server still authenticates as a Didit user. There is no application API-key mode for MCP tools.
