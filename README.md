# or1

An agent-native architecture editor for concept and schematic design. The architect directs and redlines; agents draft on a semantic model: walls, openings, derived spaces, revisions.

V0 is parallel test-fits: the architect enters a shell and a brief, N agents each produce a layout option, and each option comes back with a scorecard and a rendered plan.

Status: the v2 core, transactional SQLite mutation path, shared tool registry, and first bounded
persisted single-option pi workflow are implemented. Requirements use explicit space assignments;
scorecards pass configured concept-design checks, **not building-code certification**.
The workflow is programmatic and credential-bound; default HTTP/MCP exposes no unauthenticated
project access or mutation. The editor, rendered-option comparison, acceptance into main, and full
agent/diversity evaluation suite remain future work. Deterministic injected pi streams verify the
workflow without spending on external model APIs; they do not establish model design quality.
See the [geometry contract](packages/core/docs/geometry-contract.md) and
[brief and scorecard contract](packages/core/docs/brief-and-scorecard.md) for supported behavior and limitations.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Pure TypeScript model, ops, `apply_changes`, scorecard. No IO |
| `packages/tools` | Tool registry: one TypeBox definition set for pi agents, MCP, HTTP and the CLI |
| `packages/store` | SQLite store (`node:sqlite`): revisions, refs, briefs, redlines, runs, request outcomes |
| `apps/server` | HTTP API + SSE, MCP server (`/mcp`), run orchestrator (pi agents) |
| `apps/cli` | `or1` command line |
| `apps/editor` | Browser editor (Vite, React, Three.js) |
| `evals` | Fixtures, importers and eval scenarios |

## Development

Requires Node 24+ and pnpm 11. Node runs the TypeScript sources directly (type stripping), so there is no build step for the server or CLI.

```sh
pnpm install
pnpm check        # biome + typecheck
pnpm test         # vitest, all packages
pnpm dev:server   # http://127.0.0.1:4310 (OR1_PORT, OR1_HOST)
pnpm dev:editor   # http://localhost:5173
pnpm or1 tools    # CLI
```

Project data lives in `~/.local/share/or1` (`OR1_DATA_DIR` overrides it), never in this repo.

## Persisted workflow contracts

- [Registry](packages/tools/README.md): shared schemas, trusted credentials, metadata commands,
  explicit brief/baseline pins, and requirement-ID lineage.
- [Store](packages/store/README.md): atomic revisions/ref/run cursors/request outcomes,
  canonical idempotent replay, historical migrations, and exact evaluation pins.
- [Run workflow](apps/server/README.md): bounded single-option execution, cancellation, persisted
  tool intents/results, fail-closed restart, and supported programmatic invocation.

Legacy v1 documents stay intact. `migrateV1` is an explicit import helper; repeated-program briefs
require a reviewed v2 replacement rather than inferred allocation. There is no in-place history
rewrite or automatic resume. Resource envelopes apply to internal agent inputs too; budget
exhaustion and candidate gate failures are not proofs of infeasibility.

## Licence

Apache-2.0. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
