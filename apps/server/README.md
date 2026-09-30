# First persisted agent workflow

This is a **programmatic, single-owning-runner** workflow, not a public run-start API. HTTP offers
`/health`, `/events`, schema-generated `/mcp`, and an explicitly enabled local owner review API;
there are no unauthenticated database-write or run-start routes. Anonymous MCP clients may list tool
schemas, but registry data and mutation calls fail closed. An embedding application may pass
credential-derived context to `createMcpServer(context)` or `createMcpNodeHandler(context)`;
request/model arguments are not credentials.
MCP accepts only external credentials without an in-app run binding; supplied owner/agent roles are
rejected, never silently coerced.

## Local owner review API

By default, project-review routes are absent and HTTP startup opens no project store. To opt in,
configure `OR1_OWNER_TOKEN` as a strong secret of at least 32 bearer-safe characters. The stable
credential namespace is `local-owner`; `OR1_OWNER_NAMESPACE` may override it with a bounded nonempty
nonsecret identifier. Setting the namespace without a token, or supplying an invalid token/namespace,
fails startup. Rotating a token for the same principal should retain the namespace so exact request
replay remains possible. Never log or commit the token.

Owner-enabled startup must bind to loopback (`OR1_HOST`, default `127.0.0.1`), not `0.0.0.0` or a
network interface. Startup opens `or1.sqlite` under `OR1_DATA_DIR` / `dataDir()`; programmatic callers
must use that same database to review their options in the default server. This is a development-only
local owner capability over the whole database, not a multi-user or internet deployment. Project/ref
input is not a credential scope. Startup does not start a pi runner or spend model tokens.

The only owner HTTP tools exposed are:

| Route | Parameters | Response |
| --- | --- | --- |
| `POST /tools/review_option` | `{ projectId, ref }` for an existing option | Coherent main/option models, derived plans, brief, current-main scorecards, and advisory acceptance eligibility |
| `POST /tools/accept_option` | Registry acceptance envelope with reviewed pins and request ID | New main revision and persisted acceptance receipt, or deterministic rejection |

Both dispatch the shared TypeBox registry definitions; HTTP does not redefine schemas or write SQL.
Send `Authorization: Bearer <token>` and `Content-Type: application/json`. Credentials in query/body,
cookies, and supplied roles are not accepted. Successfully dispatched domain rejections return HTTP
200 with `{ ok: false, code, ... }`; authentication/transport failures use 4xx, and unexpected failures
use a sanitized 5xx. Responses are `no-store`. Request bodies are bounded incrementally by actual
received bytes, with registry depth/node/geometry limits still authoritative. Host and optional Origin
must be explicitly local; foreign/null origins, compressed bodies, and CORS preflights are rejected.

The editor uses `/api/tools/...` through Vite's loopback proxy, which strips `/api` and rewrites Host.
Default accepted browser origins are `http://localhost:5173` and `http://127.0.0.1:5173`; do not enable
permissive CORS to work around a different preview port. An embedding application can supply explicit
loopback `allowedOrigins` to the factory:

```ts
const server = createHttpServer({
  owner: { token: trustedToken, context: { role: "owner", namespace: "local-owner", store } },
  allowedOrigins: ["http://localhost:5173"],
});
```

Injected stores are owned by the embedding host, not closed by the factory. Owner HTTP context is
never passed into MCP. Agents/external callers cannot write main, including old cached main-write
retries; existing historical records are not rewritten. Owners may edit main directly, but accepting
an option always requires fresh passing non-certifying gates and an unchanged main fork baseline.
Acceptance appends approval provenance; it never changes option snapshots, run status, or run scores.

The UI freezes the exact acceptance request for uncertain-outcome retries. A timeout may follow a
commit: retry with the original request ID, source/main/brief/baseline/evaluator pins, and credential
namespace. Exact replay returns the historical receipt, not a claim that its revision remains latest
main. After a deterministic stale rejection, review again and create a new request ID. A sibling
option with an obsolete fork baseline cannot be made eligible by refreshing pins; merge/rebase and
workflow auto-resume are not implemented.

The UI conservatively requires the same token for an uncertain request because review does not
expose the credential namespace. Resolve uncertain requests before rotating that token. If rotation
has already occurred, the trusted embedding host must inspect/replay the frozen command with the
original namespace; the API supports this, but the UI has no credential-rotation recovery workflow.
Clearing inputs retains the intent in page memory, not durably across a closed/reloaded page.

## Supported invocation

1. Open one store in `OR1_DATA_DIR` (default `~/.local/share/or1/`). Project creation, brief edits,
   and option-ref forks must go through the shared registry with an authenticated **owner** context.
2. Obtain a trusted **agent** context from the embedding application's credential boundary, with
   the same store, a credential namespace, and `scope: { projectId, ref }`. The ref must already be
   owner-created, have a fork baseline, and not be `main`. Its baseline must still be current main.
3. Construct `createRunRunner` exactly once on process startup. This interrupts unfinished running
   records in the store, preserving their committed revisions and turns. Do not construct a second
   runner against a live owning runner's store. Queued historical records are not automatically run.
   If an aborted provider prompt never settles, further starts on that runner reject before creating
   records or calling the provider. Recovery requires restarting the owning **process**; reconstructing
   a factory inside the same process is not a supported workaround.
4. Supply a selected pi model and a `StreamFn` explicitly. The server does not invent credentials,
   choose a provider, or spend money merely by starting its HTTP process.

```ts
import { createRunRunner } from "./src/runs.ts";

// store, agentContext, selectedModel and streamFn are trusted host inputs.
// agentContext already contains credential-derived role, namespace, store and option scope.
const runner = createRunRunner({
  store,
  context: agentContext,
  model: selectedModel,
  streamFn,
});
const cancellation = new AbortController();
const run = await runner.start({
  id: crypto.randomUUID(),
  instruction: "Produce a valid allocation for this option's brief.",
  budget: { maxToolCalls: 12, maxRejections: 3 },
  signal: cancellation.signal,
});
// Inspect run.evaluation, store.readRun(run.id), and store.readRunTurns(run.id).
```

`start` returns the reloaded persisted run record, not an LLM assertion. It rejects invalid initial
configuration (including stale initial pins or concurrent starts on this runner). Once created,
run-level failures are recorded as terminal outcomes/status and a bounded settlement reason.

## Execution and outcome contract

- One pi `Agent` on one scoped option ref. Only `inspect_project`, `apply_changes`, and `scorecard`
  are exposed, with the registry's original TypeBox schemas. No shell, filesystem, metadata-write,
  main-acceptance, redline, or multi-agent tools are exposed. Tool execution is sequential.
- Scope, run binding, namespace, base revision, brief version, baseline, and request identity are
  supplied by the adapter, not the model. The mutation body is `{ ops, briefVersion,
  baselineRevisionId }`, within the registry envelope `{ projectId, ref, baseRevision, requestId,
  body }`. A model may supply that envelope, but trusted pins replace it. Wrong project/ref requests
  are rejected rather than redirected. Read tools take only `{ projectId, ref }`.
- Before each registry execution, `beforeToolCall` and a last synchronous guard check cancellation,
  elapsed time, token usage, tool-call/rejection budgets, and head/brief/baseline/main freshness.
  Store transactions independently enforce the run cursor/pins and atomically advance it on commit.
  Core synchronous geometry limits remain authoritative even if event-loop timers cannot fire.
- Tool request IDs are SHA-256 of the JSON tuple `[runId, toolCallId]`. Each exact command payload is
  persisted as `tool_intent` before execution, then its structured result is persisted separately.
  A same-ID retry in the active run uses the **original payload**, including original pins, not the
  latest ref head. Changed operations under that ID are rejected. Store idempotency prevents duplicate
  commits. Model-facing tool failures set `isError`; programmatic details are never `undefined`.
- A fresh final registry/core scorecard must have `valid: true` before `options` can be finalized.
  Its exact revision, brief, baseline, evaluator version and result are atomically saved with the
  outcome. Earlier scores and model claims cannot be relabeled as scores of a later revision.
  External option/main/brief writes make the run stale; such runs fail rather than claim an outcome.
- Otherwise the outcome is `not_found_within_budget`. User cancellation records `cancelled`, with no
  success outcome. Timeout/budget stops never admit subsequent geometry commits, including late calls
  from an injected stream that ignores abort. Partial revisions remain on the option, never implicitly
  on main. There is **no automatic resume** after restart: an intent/commit/result gap is left for
  inspection, with its committed revision retained and its running record interrupted.

## Budgets and accounting

Defaults: 16,384 reported tokens, 60,000 ms, 32 tool calls, 4 rejected calls, and 262,144 persisted
UTF-8 transcript bytes. Hard maxima: 100,000 tokens, 300,000 ms, 128 tool calls, 32 rejections, and
1,048,576 transcript bytes. All values must be positive safe integers; transcript budget must be at
least 4,096 bytes. A turn's combined transcript/result/spend is at most 65,536 UTF-8 bytes, matching
the store cap. Space is reserved for the final settlement accounting record. Oversized messages are
not silently truncated into executable tool requests. Ledger accounting is conservatively byte-sized.

`maxDurationMs` is an admission/cooperative deadline, not synchronous preemption. A core/store
transaction admitted before the deadline can finish afterward, bounded by the synchronous resource
envelope; elapsed-time checks and timeout stop subsequent admissions. This does not promise hard
wall-clock transaction rollback. Cancellation likewise cannot undo an already committed revision.

Provider calls receive remaining output-token allowance, remaining timeout, and `maxRetries: 0`.
Reported input/output/cache token usage is accounted before exposing tools from the completed message.
Rejections (including schema errors and unknown tools) consume retry budget. Turns persist cumulative
tokens, attempted tool calls, rejections, transcript bytes, elapsed time, and `usageComplete`. Attempts
are counted before tool lookup/argument validation, including invalid calls repeating an admitted ID.
Subscriber accounting/persistence faults explicitly abort rather than throwing into pi's synthetic
fallback. Cancellation/deadlines return promptly, but the runner admits no new prompt until the previous
prompt has actually settled. A provider that ignores output limits or omits truthful usage can overrun
billing before the response is received;
this API is a bounded tool-execution workflow, **not a provider-side billing guarantee**. An aborted
uncooperative stream's final usage may be unknown (`usageComplete: false`); its late response is not
executed or resumed, and its late tool result cannot append after ledger settlement.

## Independently evidenced infeasibility

The only implemented proof is `area-envelope/1`, scoped to the current bounded orthogonal geometry
contract. Coordinates are within ±1,000,000 mm, so the total disjoint bounded clear-floor faces cannot
exceed 4,000,000 m². For each **hard** requirement, the proof takes the largest matching **hard**
`min_area` (by requirement or program), multiplies by mandatory distinct quantity, and sums over the
disjoint assignments. It compares conservative integer-mm² lower bounds (floor minus one mm² per
instance) against the envelope. Soft quantities are not assumed mandatory; repeated minimum-area
constraints are not double-counted. Evidence names the `required_rooms`/`hard_constraints` gates and
is persisted with exact score pins before finalization.

Only a lower bound strictly exceeding the envelope produces `infeasible`. A candidate gate failure,
an LLM assertion, or a locked-shell area alone is not a proof. This is neither a real-world building
feasibility/code-certification claim nor a complete infeasibility detector. No benchmark-completeness,
quality-ranking, diversity, or exhaustive-search claim is made.

## Deterministic verification

`pnpm --filter @or1/server typecheck` and `pnpm --filter @or1/server test` exercise the actual pinned
pi `Agent` with injected `AssistantMessageEventStream`s, the real registry, core, and SQLite store.
No external model calls or API keys are required. Tests cover a disk-reloaded feasible result,
requirement non-double-counting, atomic/protected rejection, replay, stale pins, resource budgets,
UTF-8 limits, cancellation/deadlines (including late noncooperative responses), crash gaps, and the
independent area-envelope proof and its boundary. Run the root checks/full suite during integration.
