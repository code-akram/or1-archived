# Persisted agent workflow and studio

Runs are started by trusted local code only (a programmatic runner, `pnpm eval`, or the owner-only
local studio), never by a public run-start API. HTTP offers
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

The owner HTTP tools exposed are:

| Route | Parameters | Response |
| --- | --- | --- |
| `POST /tools/review_option` | `{ projectId, ref }` for an existing option | Coherent main/option models, derived plans, brief, current-main scorecards, and advisory acceptance eligibility |
| `POST /tools/accept_option` | Registry acceptance envelope with reviewed pins and request ID | New main revision and persisted acceptance receipt, or deterministic rejection |
| `POST /tools/create_project` | Registry creation envelope with model and brief | New project main, or deterministic rejection |
| `POST /tools/set_brief` | Registry brief-edit envelope | New brief version, or deterministic rejection |
| `POST /tools/list_projects` | `{}` | Projects with brief names and option counts |
| `POST /tools/project_overview` | `{ projectId }` | Main and every option's derived plan, fresh scorecard, staleness and run progress |

A configured studio adds `/studio/status`, `/studio/generate` and `/studio/cancel` (see
[Local multi-agent studio](#local-multi-agent-studio)).

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

## Private ChatGPT-subscription adapter

`createSubscription()` in `src/subscription.ts` is a programmatic, Node-host-only adapter for the
preferred pi 0.99.1 `openaiProvider()` **Sign in with ChatGPT** OAuth flow. It exposes only:

```ts
login(interaction: AuthInteraction, options?: LoginOptions): Promise<void>
list(): Promise<{ id: string; name: string }[]>
select(modelId: string): Promise<{ model: Model<Api>; streamFn: StreamFn }>
```

One session owns one private authenticated pi `Models` instance and its default in-memory credential
store. Keep that session for login, selection and every run; a new session/restarted process requires
another explicit login. Tokens are not returned, written to files, imported from Amp/Codex or sent
through browser application credential storage/HTTP routes. API-key auth is removed from the provider
and ambient auth lookup is disabled; `OPENAI_API_KEY` is never a fallback. Construction, listing and
selection do not authorize or call a model. Listing/selection fail before login. Available means pi's
authenticated local catalog, **not a network-verified subscription entitlement**; a provider may still
deny a listed model at inference time. Unknown/unavailable models fail before stream dispatch.

```ts
import { createSubscription } from "./src/subscription.ts";

const subscription = createSubscription();
// Human explicitly authorizes login. Host owns Node AuthInteraction, never persists its input,
// and supplies the SAME stable bare installation UUID for every subsequent login.
await subscription.login(interaction, { getDeviceId: () => installationUuid });
const availableModels = await subscription.list();
const { model, streamFn } = await subscription.select(explicitModelId);
const runner = createRunRunner({ store, context: agentContext, model, streamFn });
```

The host must arrange stable installation metadata; this adapter never generates a fresh host ID.
The preferred flow requires a valid bare UUID and uses browser PKCE authorization with loopback
callback `http://127.0.0.1:1455/auth/callback`. Its manual fallback takes the **full redirect URL**
(including code, state and issued client ID), not just a code. Honor both `AuthInteraction.signal` and
each prompt's own signal: a successful callback cancels its competing manual prompt. Keep prompt
responses and authorization URLs out of logs, ledgers and browser transport. There is **no device-code
flow for the new OpenAI provider in 0.99.1**. Legacy `openaiCodexProvider()` has device login but is not
enabled here; its credentials are not interchangeable with the preferred flow.

The selected `StreamFn` rechecks availability and rejects altered model metadata/endpoints. It calls
the same `Models.streamSimple` so pi owns serialized credential refresh. It forwards `signal`,
`timeoutMs`, `maxTokens`, `maxRetries` and reasoning; it does not forward API-key/header/environment,
payload, custom-fetch or transport-observer overrides. Upstream error bodies/causes and diagnostics
are not exposed in model-facing messages or persisted-message candidates. Failures use bounded
application-owned messages; normal content, replay signatures and usage are preserved. The host's
login interaction is trusted and must not log credentials or redirect input.

**Budget caveat:** pi 0.99.1's new OpenAI subscription request shaping deliberately omits
`max_output_tokens` even when `maxTokens` is forwarded. Runner token accounting/cancellation still
apply, but this is not a provider-side hard output/quota cap. Login and inference must remain explicit
human/host actions; adapter tests mock provider network boundaries and spend no model quota.

## Private evaluation command

From the repository root:

```sh
pnpm eval --help
pnpm eval --fixture synthetic-hall-living-study --mode replay
pnpm eval --fixture synthetic-asymmetric-bedrooms --mode replay
pnpm eval --fixture synthetic-hall-living-study --mode subscription
# Alternatively select explicitly, or log in only to print the local catalog:
pnpm eval --fixture synthetic-hall-living-study --mode subscription --model <model-id>
pnpm eval --mode subscription --list-models
```

Mode is mandatory. Replay injects the fixture's construction operations through the real pi runner
and registry; it is labelled `witness-replay`, with synthetic zero-token accounting. It proves
feasibility and workflow integration, not independent model quality. Subscription mode reads only
`shell.json` and `brief.json`, asks the model to inspect/build/score its own option, and is labelled
`chatgpt-subscription`. It uses the runner defaults: no wall-clock deadline (Ctrl+C cancels) and the
runaway guards below; the run ends as soon as the option passes every hard gate. These are
admission/accounting limits, not a provider-side quota cap.
There is no automatic acceptance, hosted mutation, retry/resume loop, or paid API-key fallback.

Subscription mode requires an interactive terminal. The operator must explicitly authorize ChatGPT
OAuth and select a model, unless `--model` was supplied. A new command requires another login;
tokens are memory-only. Nonsecret stable installation metadata is generated once in
`~/.config/or1/device-id` with mode 0600; it is not a token cache. Login times out after ten minutes,
and Ctrl+C cancels login/run. Each prompt honors both the overall and per-prompt abort signals.
The new OpenAI provider has no device-code login. If your browser is on a different machine from
the runner, either forward port 1455 to that runner for the loopback callback, or paste the **full
redirect URL** into the interactive terminal's manual prompt. Do not paste it into chat or record
it in logs. `--list-models` authenticates and prints pi's local catalog, not verified entitlements;
the provider may still refuse an inference request.

Every evaluation uses a new mode-0700 directory under `OR1_DATA_DIR/eval-runs/test-fit-*`, containing
mode-0600 `or1.sqlite`, `summary.json`, `review.json` and `turns.json`. Outputs must stay outside the
checkout, including through symlink aliases. The summary records the source mode, model, persisted
run, terminal spend/settlement, untouched-main status and whether a witness was available. The review
contains coherent models/plans, assignments, scores and acceptance pins. Successful command exit
requires an `options` outcome, passing fresh core gates, and all candidate wall endpoints inside the
original rectangular shell bounds. This last benchmark check is reported separately: core scorecard
validity alone does not prohibit a stray wall outside the shell. It is not general polygon containment
or building-code certification. A failed attempt remains inspectable and is not proof of infeasibility.

To review an output in the local editor, use the printed `directory` as `OR1_DATA_DIR` when starting
the owner-enabled loopback server (see above), then enter the printed `projectId` and ref `option`.
Acceptance remains an explicit owner's action with fresh pins. Evaluation does not promote main.
Opening the database and reloading the run/turns is supported; constructing another live runner or
automatically resuming the prior run is not. Neither this command nor local review changes the
public read-only Cloudflare pilot.

## Local multi-agent studio

`pnpm studio` (see the root README) runs `src/studio-main.ts`: explicit interactive ChatGPT login
(skipped with `--offline`), one store at `OR1_DATA_DIR/or1.sqlite`, and the loopback owner HTTP
server with the built editor served same-origin. The owner token is `OR1_OWNER_TOKEN` or a fresh
random value, printed once inside the `#token=` fragment of the studio link.

`createStudio({ store, owner, agent })` in `src/studio.ts` owns every agent run on its store. It
interrupts unfinished runs **once** on construction, then each `generate({ projectId, count, note?,
strategies? })` (1–8 agents) forks `option-N` refs from current main through the registry's
`fork_ref` with the owner context and starts one scoped runner per ref (`recover: false`) with its
own credential namespace `studio-agent:<project>:<ref>`. Runs execute concurrently; `generate`
returns as soon as their records exist. Each agent receives the shared test-fit instruction, one
design direction from `STRATEGIES` (persisted as the run's `strategySeed`; later batches continue
the rotation), and the owner's optional note. Agents cannot see each other; distinct directions are
what make options differ. `cancel({ runId })` aborts one run, `close()` aborts all and waits.

With a studio configured, owner HTTP adds `POST /studio/status`, `/studio/generate` and
`/studio/cancel`, and the registry tools `create_project`, `set_brief`, `list_projects` and
`project_overview` next to review/accept. All require the owner bearer and local Host/Origin checks.
`project_overview` returns main and every option's derived plan with a fresh scorecard, staleness,
and each run's status, outcome, strategy, pinned validity and latest cumulative spend. `fork_ref`,
`apply_changes` and run starts other than `/studio/generate` are not HTTP routes. With `editorRoot`,
the server also serves the built editor for `GET`/`HEAD` (regular files inside the directory only,
SPA fallback, `/api/*` routed to the API and never to static files).

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
- Every successful `apply_changes` result ends with a compact, same-tick fresh hard-gate summary of
  the new head (failing gates and their first findings), saving the model a scorecard round trip.
- With `finishOnValid` (default true), the run ends after the turn in which the committed head
  freshly passes every hard gate, from that summary or the model's own `scorecard` call at the
  current cursor. The model's closing message is neither requested nor awaited.
- Finalization is synchronous: the runner scores the exact run cursor with the shared core scorecard
  and closes the store's run gate in the same tick. `options` requires that fresh score to be
  `valid: true`; its exact revision, brief, baseline, evaluator version and result are atomically
  saved with the outcome. Earlier scores and model claims cannot be relabeled as scores of a later
  revision. External option/main/brief writes make the run stale; such runs fail rather than claim
  an outcome.
- A normal end, a provider error, or a **budget stop** (timeout, token, tool-call, rejection or
  transcript limit) keeps a freshly valid head as `options`; a budget stop never discards a found
  option. Otherwise the outcome is `not_found_within_budget`. User cancellation records `cancelled`
  with no success outcome, and other workflow faults do not claim one. Stops never admit subsequent
  geometry commits, including late calls from an injected stream that ignores abort. Partial
  revisions remain on the option, never implicitly on main. There is **no automatic resume** after
  restart: an intent/commit/result gap is left for inspection, with its committed revision retained
  and its running record interrupted.

## Budgets and accounting

Budgets are runaway guards, not quality limits. Defaults: **no wall-clock deadline**
(`maxDurationMs: null`), 2,000,000 reported tokens, 128 tool calls, 16 rejected calls, and 8,388,608
persisted UTF-8 transcript bytes. Hard maxima: 50,000,000 tokens, 86,400,000 ms when a deadline is
set, 1,024 tool calls, 128 rejections, and 67,108,864 transcript bytes. Values must be positive safe
integers (or `null` for the deadline); transcript budget must be at least 4,096 bytes. A turn's combined transcript/result/spend is at most 65,536 UTF-8 bytes, matching
the store cap. Space is reserved for the final settlement accounting record. Oversized messages are
not silently truncated into executable tool requests. Ledger accounting is conservatively byte-sized.

An explicit `maxDurationMs` is an admission/cooperative deadline, not synchronous preemption. A core/store
transaction admitted before the deadline can finish afterward, bounded by the synchronous resource
envelope; elapsed-time checks and timeout stop subsequent admissions. This does not promise hard
wall-clock transaction rollback. Cancellation likewise cannot undo an already committed revision.

Provider calls receive the remaining token allowance capped at the selected model's own `maxTokens`,
the remaining time only when a deadline is set, and `maxRetries: 0`.
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
UTF-8 limits, cancellation/deadlines (including late noncooperative responses and a deadline that
expires after a valid commit), the absent default deadline, per-commit gate summaries and early
finish, crash gaps, and the independent area-envelope proof and its boundary. `test/studio.test.ts`
proves studio agents run concurrently (a barrier releases only when all have started), each with a
distinct direction, and covers owner HTTP routing, static serving and traversal rejection. Run the root checks/full suite during integration.
