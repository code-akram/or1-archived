# Shared tool registry

`tools` is the ordered, adapter-independent TypeBox definition set. `inspect_project`
is first. Definitions are exported individually as `inspectProject`, `scorecardTool`,
`applyChangesTool`, `createProject`, `forkRef`, `setBrief`, `reviewOption`, and
`acceptOption`; the public types are
`ToolContext`, `ToolDefinition`, and `ToolResult`. Core model, brief, and operation
schemas are reused directly, not redeclared in adapters.

```ts
await tool.execute(parameters, {
  role: "agent", // credential-derived, never inferred from the adapter
  store,
  namespace: credentialNamespace,
  scope: { projectId, ref }, // optional trusted restriction
  runId, // optional trusted run cursor; passed unchanged to store.execute
});
```

`execute` itself is wrapped by `defineTool`: calling a definition directly cannot
bypass finite JSON/byte/schema validation, credentials, or trusted scope checks.
`store` and `namespace` are optional in the type for scaffold adapter compatibility,
but absent credentials return `unauthorized` and an absent store returns
`store_unavailable`. No project read or mutation runs in either case. Enumerating
tool definitions (including anonymous MCP `tools/list`) needs no execution context.
Namespace, role, scope, run ID and review capability are never tool parameters. Unknown parameters
are rejected. Scope is enforced before store access/replay; forks must satisfy it
for both the target and source ref. Ordinary `review_option` and `accept_option`
require an owner credential, reject **any** scope (they touch both main and the option), and
reject trusted run bindings as `invalid_run_binding`, all before store access or
cached replay. Nonowners and scoped credentials receive `forbidden`.

### Trusted project review capability

Cloud read-only adapters supply `readonly reviewProjectId?: string` on `ToolContext`
for **both owners and viewers**. When present, this is a restrictive capability:
only `review_option` may execute, its `projectId` must exactly equal the capability,
and the credential role must be `owner` or `external`, never `agent`. Every other
tool, including reads and acceptance, returns `forbidden`. Combining it with any
`scope` returns `forbidden`; a review run binding returns `invalid_run_binding`.
Malformed capability project IDs return `unauthorized`: they must be strings of
1–128 UTF-16 code units without controls below U+0020. All restrictions are checked
before even accessing the context's store. Ordinary external/MCP credentials
without this trusted capability still cannot review options.

The grant is whole-project review: a coherent result includes main and the current
brief, and any valid nonmain candidate can be reviewed. Session `refs` are navigation
suggestions, not an allowlist. The unchanged review `eligibility` describes the
option's acceptance eligibility, **not** the caller's permission to accept. A viewer
may see `{ allowed: true }` while acceptance remains forbidden. This is not a
generic read-only flag, a new tool, or authority supplied in tool parameters.

`ToolContext.store` uses `PortableStore`; registry contracts and runtime constants
come from `@or1/store/portable`, never the Node store entrypoint. The registry keeps
synchronous validation and uses Workers-supported `node:buffer` for byte budgets.

All results are `{ text, data }`. `data` contains the structured read or command
outcome. Input failures, core `InputError`s, and domain rejections return
`{ ok: false, code, message?, details? }`, not thrown untrusted-input exceptions.
Unexpected trusted store/programming failures still throw. Input budgets are
1,048,576 UTF-8 JSON bytes (`MAX_TOOL_INPUT_BYTES`), depth 64, and 100,000 visited
values. Byte accounting is incremental; it does not stringify an entire input
before checking size. Core numeric and geometry resource limits also apply.

## Read parameters and outputs

The existing read tools accept only `{ projectId, ref? }`, with ref defaulting to `main`.
They validate current v2 model shape/topology and brief semantics without repairing
persisted data or inferring v1 assignment migration.

- `inspect_project`: `{ ok: true, projectId, ref, revisionId, briefVersion,
  baselineRevisionId, model, brief, derived: { spaces, openings, adjacencies, slab,
  problems } }`. `brief` is the current core brief body. Derived output contains
  plain serializable data, not internal graph Maps or the raster/grid.
- `scorecard`: `{ ok: true, revisionId, briefVersion, baselineRevisionId,
  evaluatorVersion, result }`, where `result` is the actual core scorecard, not a
  summary or synthetic success. A failed scorecard gate is still a successful
  read (`ok: true`, `result.valid: false`). The baseline model is the immutable
  fork base; main uses its current model and a null baseline ID. Binding-invalid
  options after a brief change remain inspectable/scorable and may be repaired
  with explicit operations. Consumers must retain pins when persisting scores;
  reads do not reserve a head against later changes.

## Mutation envelopes

Every mutation requires `{ projectId, ref, baseRevision, requestId, body }`.
`set_brief` additionally requires top-level `baseBriefVersion`. IDs/ref names are
nonempty, at most 128 UTF-16 code units, without controls below U+0020. Content
versions are nonnegative safe integers, distinct from JSON `schemaVersion`.

| Name | Body | Role / behavior |
| --- | --- | --- |
| `create_project` | `{ model, brief }` | Owner only, ref `main`, baseRevision null, explicit v2. |
| `fork_ref` | `{ sourceRef }` | Owner only; ref is the new target (never main), baseRevision pins source head. |
| `set_brief` | `{ brief }` | Owner only; pins target head and project-wide brief content version. |
| `apply_changes` | `{ ops, briefVersion, baselineRevisionId }` | Main is owner-only (store-enforced before replay); options pass credential role to core policy. Requires both context pins, including null baseline on main. |
| `accept_option` | `{ sourceRef, sourceRevisionId, briefVersion, baselineRevisionId, evaluatorVersion }` | Owner only, ref `main`, nonnull baseRevision, no scope/run binding; exact pinned snapshot acceptance. |

Mutation `data` is the store command outcome: `{ ok: true, revisionId,
briefVersion, effects }` or a rejection. Stale geometry, brief and baseline pins
reject as `stale_base`, `stale_brief` and `stale_baseline`, respectively. No geometry
revision is written on rejection. Empty/incomplete models and briefs are editable;
scorecard gates are not prerequisites for editing.

All writes go through `store.execute`. Metadata validators run in its fourth
callback, inside the transaction, after store existence/head/version checks.
Creation validates and canonicalizes through core's empty operation evaluation.
Missing derived space records get fresh IDs starting at the supplied counter;
anchors/order may be canonicalized. Supplied IDs, tags and issued counters are
preserved; orphan/duplicate records or geometry that would retire identity are
rejected rather than auto-healed. The caller's submitted object is not mutated.
Creation retry identity retains the submitted command, not the derived snapshot.

Store-scoped canonical retries replay the original serialized outcome, including
after geometry or brief changes, without rerunning evaluators/metadata validators.
Keep the original command and pins on a retry. Changing commands, pins or roles
under the same request key conflicts. Authorization and scope always precede
replay. The registry never writes SQL or alters historical snapshots/briefs.

## Option review and snapshot acceptance

`review_option` requires `{ projectId, ref }` with a nonmain ref. `store.readReview`
captures main, source, immutable fork snapshot, and the current project-wide brief
coherently. Its success is `{ ok: true, projectId, ref, briefVersion,
baselineRevisionId, brief, main, option, eligibility }`. Both plans are
`{ revisionId, model, derived, scorecard }`, with the same serializable derived
fields as `inspect_project`. Main is scored against itself; the option is scored
against **returned current main**, not its historical fork. The older `scorecard`
tool keeps its historical-fork scoring contract unchanged. Stale-baseline options
remain viewable, but `eligibility` is `{ allowed: false, code: "stale_baseline" }`.
Other ineligibility codes are `invalid_identity`, `invalid_option`, and
`score_too_large`; otherwise it is `{ allowed: true }`. This advisory read does not
reserve any pins. Persisted v1, malformed, or out-of-bounds models/briefs reject;
neither review nor acceptance migrates, rederives identities, or repairs snapshots.

`accept_option` requires the mutation envelope with literal ref `main` and a
nonnull `baseRevision`. Its strict body has exactly `sourceRef` (nonmain),
`sourceRevisionId`, `briefVersion`, `baselineRevisionId` (nonnull), and
`evaluatorVersion`. Client scorecards, run evidence, model snapshots, actor,
namespace, and role are not accepted. Store verifies all pins in `BEGIN IMMEDIATE`;
the source fork baseline must equal current main, so no merge or rebase occurs.
Main/source/brief/baseline mismatches reject independently as `stale_base`,
`stale_source`, `stale_brief`, and `stale_baseline`.

The synchronous registry evaluator validates core inputs, scores source against
current main/current brief, and checks the expected evaluator version inside the
callback (`stale_evaluator`). Every core hard gate must pass; `invalid_option`
includes the actual failed gate results and findings. Protected walls/openings
remain host-relative, even for owner-authored options. Scores retain
`certification: "none"` and concept-design/heuristic gate bases: acceptance does
not certify a plan. Manual and agent options follow exactly the same eligibility
rules; run status, outcome, and stored evidence are never consulted.

Candidate next counters must not regress. An ID absent from current main must
have a numeric suffix at least its corresponding main next counter. Violations
return `invalid_identity`, not renamed IDs or adjusted counters. Combined with an
unchanged-main fork baseline, this prevents retired or divergent identity reuse.

Success is `{ ok: true, revisionId, briefVersion, effects: [], acceptance }`. The
store copies the source snapshot **unchanged**, preserving counters/tags/IDs, and
appends a new main revision with provenance. The receipt contains all body pins
plus `{ schemaVersion: 1, projectId, previousMainRevisionId, requestId,
actor: { role: "owner", namespace }, scorecard }`. The full receipt is limited to
65,536 UTF-8 JSON bytes by the store; the registry shares that bound. Review
conservatively reserves the maximum bounded request-ID encoding, while acceptance
checks the actual request ID. Exact retries return the original receipt without
rescoring, even after head/brief/evaluator changes; authorization still precedes
replay. Changing submitted evaluator or context pins conflicts with the request key.

Browser consumers may use `import type` from `@or1/tools`; `src/review.ts` contains
only type imports and DTO exports, never Node/registry runtime code. Public DTOs
are `ReviewOptionInput`, `PlanReview`, `ReviewOptionSuccess`, `ReviewOptionResult`,
`AcceptOptionInput`, `AcceptanceReceipt` (scorecard narrowed to core `Scorecard`),
`AcceptOptionSuccess`, `AcceptOptionResult`, and `CloudSession`, exported type-only
from the index. `CloudSession` contains `{ mode: "cloud", principalId, expiresAt,
projects }`, where `expiresAt` is Unix milliseconds and each project has
`{ projectId, label, membership: "owner" | "viewer", refs,
permissions: { canReview: true, canAccept: false } }`. Projects and refs are readonly
arrays; neither cloud membership grants acceptance in this pilot.

## Requirement identity and brief edits

Identity continuity is **caller-maintained, not inferred**. Keep the same room
requirement ID when reordering or editing its specification. A new ID explicitly
means a new logical requirement: replacing a deleted row with matching content
does not transfer assignments or infer equivalence. Core rejects same-version
semantic duplicate requirements, including duplicates with different IDs.

Inside the metadata transaction, `set_brief` reads the full `store.readBriefs`
history. Current IDs may be edited/reordered; any v2 ID present historically but
absent from the current brief is permanently retired and cannot be reintroduced.
Historical v1 documents are left unchanged and are never used to infer IDs or
repeated-program assignments. Importing legacy data requires explicit reviewed
v2 model/brief input, outside this tool surface: use core's explicit `migrateV1`
where safe (repeated programs return `review_required`), review/repair assignments
as needed, then owner `create_project` with a **fresh project ID**. The original
project and its history remain intact. There is no in-place conversion tool.
Domain tools reject v1 reads/mutations; legacy snapshots and briefs remain
available through trusted store inspection (`readState`, `readSnapshot`,
`readBriefs`), but cannot be validated/scored through the v2 tool surface until
explicitly adopted into a new project.

The target ref's current model must remain binding-compatible on a brief change.
To change an assigned requirement's program, first explicitly clear the affected
assignments, edit the brief with the same logical ID, then repair space program
and assignment tags via `apply_changes`. Removing/replacing an assigned ID also
requires clearing/repairing those assignments first. Nothing auto-transfers tags.
Other option models are not rewritten: their previous scores are stale by brief
version, and new scores expose binding failures until explicit repairs are made.

## Verification

`pnpm exec biome check packages/tools`, `pnpm --filter @or1/tools typecheck`, and
`pnpm --filter @or1/tools test` cover the scoped package. Integration fixtures use
synthetic models and SQLite `:memory:` only. Root `pnpm check` / `pnpm test` verify
existing adapter compatibility and the shared core/store contracts.
