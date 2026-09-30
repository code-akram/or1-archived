# AGENTS.md

Rules for humans and agents working in this repo.

## Architecture invariants

- **One write path.** Geometry/tag changes go through `applyChanges` in `@or1/core`, called via the tool registry. Project creation, ref creation and brief edits use metadata commands through the same registry/store transaction boundary, not fake geometry ops. Every mutation has a base revision, a scoped request ID and a credential-derived role. Adapters never write SQL directly; run-ledger writes use the store's bounded persistence API.
- **The core is pure.** `packages/core` has no IO, no Node APIs and no browser APIs. It runs in the server, the browser replica and the CLI.
- **One tool definition set.** Tools are defined once in `packages/tools` with TypeBox schemas. pi `AgentTool`s, MCP tools (via `fromJsonSchema`), HTTP handlers and CLI commands are generated from it. Never redeclare a tool's schema in an adapter.
- **Roles come from credentials,** not from which interface a call arrives through. MCP callers are `external`; in-app runs are `agent`; the CLI defaults to `agent`.
- **V0 geometry:** one floor, orthogonal walls, integer millimetres.

## Code

- TypeScript with erasable syntax only (`erasableSyntaxOnly`): no `enum`, `namespace` or parameter properties. Node runs sources directly.
- Relative imports use the `.ts` extension.
- Workspace packages export `./src/index.ts`; there is no build step for libraries.
- Tests live in each package's `test/` directory (vitest). Use fast-check for geometry invariants.
- Run `pnpm check` and `pnpm test` before committing.

## Dependencies

- Direct dependencies are pinned to exact versions (`save-exact`).
- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` are pinned to 0.99.1, and `typebox` to 1.3.27 to match pi. Upgrade them together, deliberately.
- Dependency build scripts are allowed or denied explicitly in `pnpm-workspace.yaml` (`allowBuilds`).
- Code ported from reference repos must be logged in `THIRD_PARTY_NOTICES.md` with source, pinned SHA, path, licence and copyright line. Never port from read-only (GPL, LGPL, AGPL, source-available) repos.

## Data and secrets

- Project data, eval run outputs, renders, traces and private evidence go in `~/.local/share/or1/` (`OR1_DATA_DIR`), never in the repo.
- No secrets in the repo. `.env*` files are ignored except `.env.example`. CI runs gitleaks and rejects forbidden paths and files over 1 MiB.
- Eval fixtures in `evals/fixtures/` are public and synthetic or derived from openly licensed data with attribution. Real client projects never become fixtures. The held-out eval set stays outside the repo.
