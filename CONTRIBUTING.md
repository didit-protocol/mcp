# Contributing

Thanks for your interest in the Didit MCP server!

## Development

```bash
npm install
npm run build        # tsc → dist/
npm test             # node --test test/
npm run dev          # ts-node src/index.ts (stdio)
npm run dev:http     # ts-node src/http.ts (hosted)
```

- TypeScript, Node 20+. Keep tool definitions and dispatch in `src/index.ts`; one module per domain under `src/tools/`.
- New tools must declare clear `annotations` (read-only / destructive) so clients can group and gate them.
- Don't leak secrets, PII, or internal hostnames in error messages — route errors through the sanitizer in `src/security.ts`.

## Testing against Didit

By default the server talks to Didit production (`verification.didit.me`, `apx.didit.me`, `business.didit.me`). Override the base-URL environment variables (see [`.env.example`](.env.example)) to point at your own environment. Use a throwaway application API key for local experiments; never commit a real key.

## Pull requests

- Keep PRs focused; describe the behavior change and how you verified it.
- Run `npm run build` and `npm test` before pushing.
- By contributing you agree your contributions are licensed under the [MIT License](LICENSE).

## Reporting issues

Open a GitHub issue with reproduction steps. For anything security- or data-sensitive, email **security@didit.me** instead of filing a public issue.
