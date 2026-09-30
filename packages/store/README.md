# Store API

`openStore(path)` opens a synchronous SQLite store. Persisted model, brief, effects,
budget, seed and transcript data are finite JSON (`unknown` here); core schemas and
domain validation belong to the authenticated tool registry. `db` is exposed for
inspection and legacy compatibility, not application writes.

## Portable engine

`@or1/store/portable` exports `createStore(driver): PortableStore`, the complete
command/result/caller/evaluator/run types, the three `MAX_*_BYTES` limits, and the
synchronous SQL seam below. This is the same engine used by `openStore`, not a
second implementation. It imports only `node:crypto` (synchronous hashing/UUIDs)
and `node:buffer` (UTF-8 byte limits); compatible runtimes must provide those APIs.
It does not import SQLite, filesystem/path/OS APIs, or use process environment.

```ts
type SqlBinding = string | number | null;
type SqlRow = Record<string, SqlBinding>;
type SqlStatement = {
  get(...bindings: SqlBinding[]): SqlRow | undefined;
  all(...bindings: SqlBinding[]): SqlRow[];
  run(...bindings: SqlBinding[]): { changes: number };
};
type SqlDriver = {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  transaction<T>(callback: () => T, mode: "read" | "write"): T;
  getSchemaVersion(): number;
  setSchemaVersion(version: number): void;
  close(): void;
};
```

Drivers must enable foreign-key enforcement before initialization, support the
shared SQLite schema/migrations/triggers, and eagerly materialize rows. No async
callbacks or cursors may escape a transaction. `run().changes` counts changes
made by that statement, not cumulative changes or trigger side effects.
Transactions commit on return and roll back on throw; `write` serializes writers,
and `read` supplies a coherent snapshot without a write reservation where supported.

`createStore` runs initialization in a driver `write` transaction. All version
reads/writes happen inside it, so a failed migration rolls back both schema and
version changes. The engine emits no PRAGMAs or transaction-control SQL. Drivers
own schema-version storage (Node uses `user_version`; other runtimes may use a
private metatable). The factory takes ownership of the driver: initialization
failure calls `driver.close()`, and `store.close()` delegates to it on success.

`PortableStore` has every existing store method but no `db`. The Node entry point
retains all exports, `dataDir` and `openStore`, with
`Store = PortableStore & { readonly db: DatabaseSync }`. Its driver preserves
`BEGIN` for review reads, `BEGIN IMMEDIATE` for writes, foreign keys, the 5000 ms
busy timeout, WAL for disk stores, and close-on-initialization-failure behavior.
Raw database inspection remains Node-only.

## Commands

```ts
store.execute(command, trustedCaller, evaluate?, validateMetadata?)
```

Every command contains `type`, `projectId`, `ref`, `baseRevision` and `requestId`.
The caller is `{ role: "owner" | "agent" | "external", namespace: string, runId?: string }`,
derived from credentials and trusted workflow context, never user-supplied command arguments.
IDs/ref names and run IDs are nonempty strings of at most 128 UTF-16 code units,
with no control characters below U+0020;
the credential namespace has the same rules but permits 256 code units.

| Type | Body | Preconditions and behavior |
| --- | --- | --- |
| `create_project` | `{ model: unknown, brief: unknown }` | Owner only; project must not exist; `baseRevision: null`. Creates project, root revision, named ref and brief content version 1 atomically. |
| `fork_ref` | `{ sourceRef: string }` | Owner only; `ref` is the new target name, `baseRevision` must equal the source ref head. Pins the fork baseline to that revision. |
| `set_brief` | `{ brief: unknown, baseBriefVersion: number }` | Owner only; `baseRevision` must equal the target ref head and `baseBriefVersion` must equal the current project-wide brief content version. Appends a brief version without creating a geometry revision. The version is a nonnegative safe integer (0 for legacy projects without briefs). |
| `apply_changes` | `unknown` | Owner only on `main`; other refs permit agent/external edits. `baseRevision` must equal the target ref head. Registry supplies the canonical core command, including caller-supplied context pins, and a synchronous evaluator. |
| `accept_option` | `{ sourceRef, sourceRevisionId, briefVersion, baselineRevisionId, evaluatorVersion }` | Owner only, no run binding; target `ref: "main"` and non-null `baseRevision`. Promotes an unchanged non-main fork snapshot after exact head, brief and baseline checks and registry evaluation. |

Results are `{ ok: true, revisionId, briefVersion, effects }` or
`{ ok: false, code, message?, details? }`. `briefVersion` is the store's append-only
content version, not a brief JSON schema version. A stale geometry head rejects
with `stale_base`; a stale brief content version rejects with `stale_brief`.

An evaluator receives `RefState` (project/ref/head/model, latest brief, immutable
fork baseline model) and returns `{ ok: true, model, effects }` or a rejection.
Successful geometry revisions, ref updates and request outcomes commit together
under `BEGIN IMMEDIATE`. Exceptions roll back all writes and do not consume a key.

The optional metadata validator receives `RefState | null`: null for creation,
source ref state for a fork, target ref state for a brief edit. It runs **inside the
same transaction**, after existence/head/brief preconditions and before writes.
It must be synchronous and side-effect free except for store reads. Return void
to accept or a deterministic rejection to cache. Registry callbacks should perform
core schema/bounds/geometry/binding checks and may call `store.readBriefs(projectId)`
for requirement-ID lineage checks against the transaction's complete brief history:

```ts
store.execute(command, trustedCaller, undefined, (state) => {
  const history = store.readBriefs(command.projectId);
  return validateCoreMetadata(command, state, history); // rejection or void
});
```

Request keys are scoped by `(projectId, credential namespace, requestId)`.
Canonical JSON key order, the full command, trusted role and initially pinned
brief/fork context define identity. Exact retries replay the serialized outcome
without evaluating or validating again, even after heads/briefs advance. Changed
commands/roles/context pins conflict with `request_conflict`; retries must retain
their original command, including preconditions. Authorization always precedes
replay. Deterministic rejections are cached even when the project does not exist;
invalid envelopes/callers/bindings and forbidden calls are rejected before caching.

The workflow may attach `Caller.runId` to `apply_changes` only. The store checks
that the run exists and belongs to the command's project/ref **before replay**
(`invalid_run_binding` otherwise). The trusted run ID is part of request identity;
the mutable run cursor and status are not. Historical identical commands may
replay after completion, interruption, or head/context advancement without changing
the run cursor. An absent binding retains the exact v2 fingerprint format.

### Snapshot acceptance

`execute` has a command-specific overload for `AcceptanceCommand`, with a synchronous
`AcceptanceEvaluator` receiving `AcceptanceStates = { main: RefState, source: RefState }`.
Return `{ ok: true, evaluation: { evaluatorVersion: string, result: unknown } }` or
a rejection. The registry owns scorecard schemas and core semantics; no evaluator
model or effects are accepted. Malformed/asynchronous results and exceptions throw
and roll back uncached. Deterministic rejections are cached.

New acceptance checks the current main head (`stale_base`), source head
(`stale_source`), latest brief (`stale_brief`) and that the supplied baseline equals
both the immutable source fork baseline and expected/current main (`stale_baseline`).
Evaluator version must match the submitted version (`stale_evaluator`). Main/nonfork
sources or a non-main target reject `invalid_ref`. Missing refs reject `ref_not_found`;
foreign/missing source revision pins reject `stale_source`.

Success adds `acceptance: AcceptanceReceipt` to the ordinary result, with `effects: []`.
The receipt contains all submitted body pins plus `schemaVersion: 1`, `projectId`,
`previousMainRevisionId`, `requestId`, `actor: { role: "owner", namespace }` and opaque
`scorecard`. The entire canonical receipt is capped at `MAX_ACCEPTANCE_RECEIPT_BYTES`
(65,536 UTF-8 bytes; `score_too_large`). The revision parents the old main head,
copies the source snapshot bytes exactly, and stores
`{ type: "accept_option", command, acceptance }` as its change set. Only main advances;
source/history/briefs/run cursors and evaluations are unchanged. Existing run stale
guards reject subsequent work on options with the former main baseline.

Authorization and run-binding checks precede replay. Exact retries replay even after
all pins or the evaluator change; altered submitted commands conflict. Acceptance
requires no migration and does not alter existing fingerprint formats.

New run-bound work requires a running run (`run_not_running` otherwise), and
`baseRevision == run.revisionId == ref head`, with unchanged brief content version,
fork baseline and current main baseline (`stale_run` otherwise). Candidate revision,
ref, run cursor and request outcome commit atomically. A conditional cursor update
failure throws and rolls back everything. An external head edit cannot be adopted
merely by passing its new head as the next base. Rejected evaluations never advance
the cursor; the registry must not permit callers to forge a workflow binding.

## Reads and runs

- `readReview(projectId, sourceRef)` returns `{ ok: true, states: AcceptanceStates }`
  or a rejection, reading main/source/brief in a short coherent deferred transaction
  without reserving a write lock. It rejects main/nonfork sources with `invalid_ref`.
- `readState(projectId, ref)` returns `RefState | null`.
- `readSnapshot(projectId, revisionId)` returns JSON or throws if the revision does
  not belong to that project. Historical null snapshots remain null.
- `readBriefs(projectId)` returns ordered `{ version, body }` history.
- `createRun(run: Omit<RunRecord, "initialRevisionId" | "evaluation">)` creates a queued
  run with null outcome, nonnegative safe-integer retry count, and current
  `revisionId`, `briefVersion`, and
  `baselineRevisionId` pins. On a fork, the baseline must also be the current main
  head. Other fields are `id`, `projectId`, `ref`, `instruction`, `strategySeed`
  and `budget` (the latter two JSON). It derives immutable `initialRevisionId`
  from the initial revision; `revisionId` is the cursor advanced only by the run's
  own bound edits. Initial `evaluation` is null.
- `updateRun(id, { status?, retryCount? })` updates only queued/running runs;
  `done` is reserved for finalization. Other statuses are `failed`, `cancelled`
  and `interrupted` (plus `queued`/`running`). Pins/cursor/provenance/evaluation are
  not patchable. Finished/interrupted runs cannot be restarted by this helper.
- `finalizeRun(id, outcome, evaluation?)` accepts `options`, `infeasible` or
  `not_found_within_budget` only while all pins remain current. Changed option
  head, brief content version or main baseline rejects `stale_run` without writing
  an outcome. Scored completion requires the exact evaluation object below;
  `options`/`infeasible` without it reject `score_required`. Only unscored
  `not_found_within_budget` may omit evaluation. Mismatched evaluation pins reject
  `stale_score`, including a score from before the run's own cursor advancement.
  The complete evaluation persists atomically with status/outcome. Repeating an
  identical outcome and canonical evaluation succeeds while pins are current;
  changing the score/version/outcome or other finished status rejects `run_finished`.
- `readRun(id)` returns `RunRecord | null`, including `initialRevisionId` and
  persisted `evaluation: RunEvaluation | null`.
- `interruptRunningRuns(): number` explicitly marks unfinished running runs as
  interrupted in one transaction, returning the number changed. The single-runner
  workflow calls this on restart; opening the store itself never auto-interrupts
  or resumes runs. Queued/completed runs and existing/missing turns are unchanged.
- `saveRunTurn({ runId, turn, transcript, result, spend })` appends a unique
  nonnegative safe-integer turn. The combined canonical JSON values are limited
  to `MAX_RUN_TURN_BYTES` (65,536 UTF-8 bytes); duplicates do not overwrite history.
- `readRunTurns(runId)` returns those records ordered by turn number;
  `readLastRunTurn(runId)` returns only the latest (its cumulative spend), or null.
- `listProjects()`, `listRefs(projectId)` and `listRuns(projectId)` are read-only listings
  (creation order for projects and runs, name order for refs) for owner navigation.

```ts
type RunEvaluation = {
  revisionId: string; // must match cursor and current ref head
  briefVersion: number;
  baselineRevisionId: string | null;
  evaluatorVersion: string;
  result: unknown;
};
```

Evaluator/revision/baseline IDs use the same 128-unit bounds; the brief content
version must be a nonnegative safe integer. The entire canonical evaluation JSON
is limited to `MAX_RUN_EVALUATION_BYTES` (65,536 UTF-8 bytes; `score_too_large`).
Malformed evaluation pins/version reject `invalid_score`; non-JSON throws.
The registry owns result schema/semantics, including whether the requested outcome
is justified; the store owns exact pin binding and persistence.

## Migration

Schema version 0/1/2 (Node `user_version`) migrates atomically to 3 without rewriting revision,
brief, ref, run or transcript content. Legacy request outcomes retain exact JSON
and live in a separate unscoped partition; new scoped commands cannot replay them.
Legacy v0/v1 runs gain null revision/baseline/initial provenance and cannot be
finalized by this API; legacy turn results read as null. V2's fixed initial revision
pin becomes immutable provenance; existing content/status/outcomes stay unchanged
and evaluations begin null. Cross-project historical revision references
fail migration rather than being repaired silently. Future schema versions fail
on open. New revision/ref/outcome/run writes enforce project revision ownership;
revision content, brief versions, fork baselines and run provenance/context pins
are immutable.
