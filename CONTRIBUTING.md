# Contributing to the Didit MCP server

Node 22 / TypeScript / `@modelcontextprotocol/sdk`. The Didit MCP server: the tool surface
every AI agent uses to drive Didit's verification APIs.

## The feature-config contract is generated, never written

`src/schema/feature-config-schema.json` is a **byte-for-byte copy** of
`service-didit-verification/src/applications/config/feature_config_schema.json`, which that
repo generates from `FEATURE_CONFIG_SERIALIZERS` — the serializers that actually validate a
workflow save. Everything the workflow tools say about a feature's `config` object is rendered
from it by `src/feature-config-schema.ts`.

**Never hand-write a feature-config key, shape or enum into a tool description.** That is what
this contract exists to end: the descriptions used to be prose, `DATABASE_VALIDATION` never made
it in, and an agent asked for "a Database Validation workflow for Brazil" produced a node with no
countries — the API accepted the config and threw the unknown keys away, with nothing anywhere
going red.

Prose in those descriptions is for what a schema cannot say: graph structure, branch semantics,
the KYC/KYB segregation rule, and the allow-list shorthands this server normalizes on the way
out. Not the key list.

### When the backend changes a feature config

1. In `service-didit-verification`: change the serializer, run
   `python3 scripts/generate_feature_config_schema.py`, commit the regenerated artifact. Its own
   CI blocks the PR until you do.
2. Here: copy that artifact over `src/schema/feature-config-schema.json`.
3. `npm run schema:readme` — regenerates the README's per-feature reference.
4. `npm test` — `test/feature-config-contract.test.mjs` fails if any contract key stopped being
   advertised, and `test/workflow-config-round-trip.test.mjs` fails if a config no longer
   survives validate → set → get intact.

Forget step 2 and the nightly **Feature-config drift check** opens an issue within a day — but a
customer may hit it first, so do not use it as the workflow.

## The documentation keeps a copy of the tool catalog

The public documentation states how many tools there are and describes each one in a table.
Both are checked against a copy of this server's catalog, because they were written by hand and drifted: the docs said 177 tools when the count was 185, and eight tools had no row.

`npm run catalog:export -- <file>` writes that catalog from the server's own `tools/list` answer: every tool the hosted server lists to a signed-in person, with its type (read, write or destructive), its group, the role permission it needs and its required arguments, plus what only a local server adds.

When a release adds, removes, renames or retypes a tool, or changes the permission it needs: run the export on a build of the commit being released, copy the file over the documentation repository's `data/mcp-tools.json`, and fix the rows and counts its check names.
`test/tool-catalog-export.test.mjs` pins what the export promises.

## Tests run on every pull request

`.github/workflows/pr.yml` runs `npm test` (which is `tsc` + all of `test/*.test.mjs`) and
`npm run schema:check`. Before it existed this repo had no `pull_request` trigger at all: the
suite only ran on a push to `development`, so code reached staging without a single test having
executed. Do not remove the trigger.

## Round-trip, not response-shape

A config that the API silently rewrites is either a bug or an undocumented normalization, and
both must be visible. `test/workflow-config-round-trip.test.mjs` drives validate → set → get over
a fake backend that stores what was PUT and serves it back, then `deepEqual`s the config against
what the caller asked for. When you add an intentional normalization, assert it explicitly there —
an unasserted difference reads as a silent drop.
