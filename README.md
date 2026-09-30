# or1

An agent-native architecture editor for concept and schematic design. The architect directs and redlines; agents draft on a semantic model: walls, openings, derived spaces, revisions.

V0 is parallel test-fits: the architect enters a shell and a brief, N agents each produce a layout option, and each option comes back with a scorecard and a rendered plan.

Status: the v2 core, transactional SQLite mutation path, shared tool registry and persisted pi
workflow are implemented, with a local **test-fit studio**: enter a rectangular shell and a room
brief, let several agents build options in parallel (each on its own option ref, with a different
design direction), compare them at one scale with their scorecards, and accept one into main.
Requirements use explicit space assignments; scorecards pass configured concept-design checks,
**not building-code certification**. Default HTTP/MCP exposes no unauthenticated project access or
mutation; generation is local and owner-only. Free-form geometry editing, non-rectangular shells,
automatic recovery/resume and a scored diversity benchmark remain future work. Deterministic
injected pi streams verify the workflow without spending on external model APIs; they do not
establish model design quality.
See the [geometry contract](packages/core/docs/geometry-contract.md) and
[brief and scorecard contract](packages/core/docs/brief-and-scorecard.md) for supported behavior and limitations.

Cloudflare hosting is a separate **authenticated, synthetic-data read-only review pilot** using
Workers Static Assets and SQLite Durable Objects. It preserves the local workflow; it does not
expose cloud acceptance, online agents or real-client projects. See the
[deployment and private provisioning runbook](deploy/cloudflare/README.md) and
[editor session contract](apps/editor/README.md).

Initial development can use the separate, temporary **public synthetic read-only** host
`or1-dev.orfloat.com`. Its explicit bypass configuration has a fixed deadline of at most seven days,
an independent database namespace, and visible non-Access authentication warnings. It cannot
enable bypass on production `or1.orfloat.com`. Remove it at the next sprint acceptance review or
before any real data/hosted writes, whichever comes first; see the runbook for enablement/removal.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Pure TypeScript model, ops, `apply_changes`, scorecard. No IO |
| `packages/tools` | Tool registry: one TypeBox definition set for pi agents, MCP, HTTP and the CLI |
| `packages/store` | Portable SQLite engine + Node driver: revisions, refs, briefs, redlines, runs, request outcomes |
| `apps/server` | HTTP API + SSE, MCP server (`/mcp`), run orchestrator (pi agents) |
| `apps/cli` | `or1` command line |
| `apps/editor` | Browser studio and option review (Vite, React, SVG) |
| `apps/cloudflare` | Access-verified read-only API and project SQLite Durable Objects |
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

## Test-fit studio

```sh
pnpm studio                      # build the editor, log in to ChatGPT, serve http://127.0.0.1:4310
pnpm studio -- --model <id>      # skip the model prompt
pnpm studio -- --offline         # no login: review and acceptance only
```

The studio asks you to authorize your own ChatGPT subscription in the terminal (tokens stay in
memory; no API-key fallback), then prints a link whose `#token=` fragment carries a fresh random
owner token. Browsers never send a fragment to the server; the editor moves it into page memory and
removes it from the address bar. From a remote machine, forward the port first
(`ssh -L 4310:127.0.0.1:4310 <runner>`), and during login also 1455 for the OAuth callback, or paste
the full redirect URL into the terminal.

In the editor, start from a preset or enter the shell (width, depth, wall, entrance, windows) and
brief (rooms with minimum/target areas, daylight and required doors); the core validates both as
you type. **Generate** forks one option ref per agent from main and runs the agents in parallel,
each with a different direction (linear spine, compact hub, daylight first, social/quiet zones,
other axis) plus your optional batch note. Runs have **no wall-clock limit**, get a fresh
hard-gate summary after every commit, and stop as soon as the option passes every hard gate; a run
stopped by a runaway guard still keeps a freshly valid option. Cards update live; review one to
compare it with main and accept it. Accepting makes the sibling options stale (still viewable).

## Private test-fit evaluations

Two feasible synthetic multi-room benchmarks now exercise partitions, connecting doors, explicit
room assignments, asymmetric requirements and pinned scorecards. Run the disclosed witness replay
without a login or model call:

```sh
pnpm eval --fixture synthetic-hall-living-study --mode replay
pnpm eval --fixture synthetic-asymmetric-bedrooms --mode replay
```

Each invocation creates a fresh private database, review and run ledger under
`OR1_DATA_DIR/eval-runs/`. It never overwrites an earlier evaluation or automatically accepts main.
Replay proves workflow/fixture feasibility, **not agent design quality**.

For a real attempt, run this in an interactive terminal and explicitly authorize your own ChatGPT
subscription through the browser prompt, then select a model:

```sh
pnpm eval --fixture synthetic-hall-living-study --mode subscription
```

Live mode loads only the shell and brief, not witness solutions. OAuth tokens stay in process memory;
there is no paid API-key fallback or public agent endpoint. The authenticated model list is a local
catalog, not verified entitlement. Runs have no wall-clock deadline (Ctrl+C cancels) and finish once
the option passes every hard gate. Runner budgets are runaway guards, **not a hard provider quota
cap**. See the [evaluation and local review instructions](apps/server/README.md#private-evaluation-command)
for remote-browser login, output interpretation and explicit owner review.

## Review and acceptance

The local review API is opt-in: configure a strong `OR1_OWNER_TOKEN` (at least 32 bearer-safe
characters) in the server environment, then run the server on loopback and the editor. Enter the
token in the editor's password field and an existing project ID and option ref (or open the studio
link above). The token stays in browser memory; apart from the studio's one-time `#token=` fragment,
do not put it in a URL, Vite environment variable, committed file, or browser storage.
See [local owner configuration](apps/server/README.md#local-owner-review-api) for the database path
and transport contract. This credential grants owner access to the local database, not just the
project entered in the UI. Do not expose this development service to a network.

Review compares main and the candidate at a shared scale, with actual requirement assignments,
score gates, and exact revision/brief/baseline pins. Acceptance freshly scores the pinned option in
the same transaction that appends a main revision and durable approval receipt. Agents and external
callers cannot write main; owners can still edit it directly without an acceptance score.

Acceptance is **promotion, not merge**: an option's immutable fork baseline must still be current
main. Accepting one option makes its siblings stale, although they remain viewable. Refreshing a
review cannot make a diverged option eligible; there is no automatic rebase or ID remapping. Source
options, run records, and historical snapshots are preserved. A lost acceptance response must be
retried with its original request ID and pins, not a newly generated command.

## Persisted workflow contracts

- [Registry](packages/tools/README.md): shared schemas, trusted credentials, metadata commands,
  explicit brief/baseline pins, and requirement-ID lineage.
- [Store](packages/store/README.md): atomic revisions/ref/run cursors/request outcomes,
  canonical idempotent replay, historical migrations, and exact evaluation pins.
- [Run workflow](apps/server/README.md): scoped single-option execution, the multi-agent studio,
  cancellation, persisted tool intents/results, fail-closed restart, and programmatic invocation.

Legacy v1 documents stay intact. `migrateV1` is an explicit import helper; repeated-program briefs
require a reviewed v2 replacement rather than inferred allocation. There is no in-place history
rewrite or automatic resume. Resource envelopes apply to internal agent inputs too; budget
exhaustion and candidate gate failures are not proofs of infeasibility.

## Licence

Apache-2.0. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
