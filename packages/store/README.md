# Store API

`openStore(path)` opens a synchronous SQLite store. Persisted model, brief, effects,
budget, seed and transcript data are finite JSON (`unknown` here); core schemas and
domain validation belong to the authenticated tool registry. `db` is exposed for
inspection and legacy compatibility, not application writes.

## Commands

```ts
store.execute(command, trustedCaller, evaluate?, validateMetadata?)
```

Every command contains `type`, `projectId`, `ref`, `baseRevision` and `requestId`.
The caller is `{ role: "owner" | "agent" | "external", namespace: string }`, derived
from credentials, never user-supplied command arguments. IDs/ref names are nonempty
strings of at most 128 UTF-16 code units, with no control characters below U+0020;
the credential namespace has the same rules but permits 256 code units.

| Type | Body | Preconditions and behavior |
| --- | --- | --- |
| `create_project` | `{ model: unknown, brief: unknown }` | Owner only; project must not exist; `baseRevision: null`. Creates project, root revision, named ref and brief content version 1 atomically. |
| `fork_ref` | `{ sourceRef: string }` | Owner only; `ref` is the new target name, `baseRevision` must equal the source ref head. Pins the fork baseline to that revision. |
| `set_brief` | `{ brief: unknown, baseBriefVersion: number }` | Owner only; `baseRevision` must equal the target ref head and `baseBriefVersion` must equal the current project-wide brief content version. Appends a brief version without creating a geometry revision. The version is a nonnegative safe integer (0 for legacy projects without briefs). |
| `apply_changes` | `unknown` | `baseRevision` must equal the target ref head. Registry supplies the canonical core command, including caller-supplied context pins, and a synchronous evaluator. |

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
invalid envelopes/callers and forbidden calls are rejected before caching.

## Reads and runs

- `readState(projectId, ref)` returns `RefState | null`.
- `readSnapshot(projectId, revisionId)` returns JSON or throws if the revision does
  not belong to that project. Historical null snapshots remain null.
- `readBriefs(projectId)` returns ordered `{ version, body }` history.
- `createRun(run: RunRecord)` creates a queued run with null outcome, nonnegative
  safe-integer retry count, and current `revisionId`, `briefVersion`, and
  `baselineRevisionId` pins. On a fork, the baseline must also be the current main
  head. Other fields are `id`, `projectId`, `ref`, `instruction`, `strategySeed`
  and `budget` (the latter two JSON).
- `updateRun(id, { status?, retryCount? })` updates only queued/running runs;
  `done` is reserved for finalization. Other statuses are `failed`, `cancelled`
  and `interrupted` (plus `queued`/`running`).
- `finalizeRun(id, outcome)` accepts `options`, `infeasible` or
  `not_found_within_budget` only while all pins remain current. Changed option
  head, brief content version or main baseline rejects `stale_run` without writing
  an outcome. Repeating an identical finalization succeeds while pins are current;
  a different outcome or other finished status rejects `run_finished`.
- `readRun(id)` returns `RunRecord | null`.
- `saveRunTurn({ runId, turn, transcript, result, spend })` appends a unique
  nonnegative safe-integer turn. The combined canonical JSON values are limited
  to `MAX_RUN_TURN_BYTES` (65,536 UTF-8 bytes); duplicates do not overwrite history.
- `readRunTurns(runId)` returns those records ordered by turn number.

## Migration

Schema `user_version` 0/1 migrates atomically to 2 without rewriting revision,
brief, ref, run or transcript content. Legacy request outcomes retain exact JSON
and live in a separate unscoped partition; new scoped commands cannot replay them.
Legacy runs gain null revision/baseline pins and cannot be finalized by this API;
legacy turn results read as null. Cross-project historical revision references
fail migration rather than being repaired silently. Future schema versions fail
on open. New revision/ref/outcome/run writes enforce project revision ownership;
revision content, brief versions and fork baselines are immutable.
