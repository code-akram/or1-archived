# Shared tool registry

`tools` is the ordered, adapter-independent TypeBox definition set. `inspect_project`
is first. Definitions are exported individually as `inspectProject`, `scorecardTool`,
`applyChangesTool`, `createProject`, `forkRef`, and `setBrief`; the public types are
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
Namespace, role, scope and run ID are never tool parameters. Unknown parameters
are rejected. Scope is enforced before store access/replay; forks must satisfy it
for both the target and source ref.

All results are `{ text, data }`. `data` contains the structured read or command
outcome. Input failures, core `InputError`s, and domain rejections return
`{ ok: false, code, message?, details? }`, not thrown untrusted-input exceptions.
Unexpected trusted store/programming failures still throw. Input budgets are
1,048,576 UTF-8 JSON bytes (`MAX_TOOL_INPUT_BYTES`), depth 64, and 100,000 visited
values. Byte accounting is incremental; it does not stringify an entire input
before checking size. Core numeric and geometry resource limits also apply.

## Read parameters and outputs

Both read tools accept only `{ projectId, ref? }`, with ref defaulting to `main`.
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
| `apply_changes` | `{ ops, briefVersion, baselineRevisionId }` | Credential role passed to core policy; requires both context pins, including null baseline on main. |

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
