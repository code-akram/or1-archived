import { Buffer } from "node:buffer";
import {
  applyChanges,
  BriefSchema,
  bindingProblems,
  checkModel,
  derive,
  InputError,
  type Model,
  ModelSchema,
  OpsSchema,
  type Scorecard,
  scorecard,
  validateBrief,
  validateModel,
} from "@or1/core";
import type {
  AcceptanceEvaluator,
  AcceptanceStates,
  Caller,
  Evaluation,
  RefState,
  Rejection,
  RunRecord,
} from "@or1/store/portable";
import { MAX_ACCEPTANCE_RECEIPT_BYTES } from "@or1/store/portable";
import { type TSchema, Type } from "typebox";
import { defineTool, result, type ToolContext, type ToolDefinition } from "./registry.ts";
import type {
  AcceptanceReceipt,
  PlanReview,
  ProjectListing,
  ProjectOverview,
  RefOverview,
  ReviewOptionSuccess,
  RunSummary,
} from "./review.ts";

export type { ToolContext, ToolDefinition, ToolResult } from "./registry.ts";
export { defineTool, MAX_TOOL_INPUT_BYTES } from "./registry.ts";
export type {
  AcceptanceReceipt,
  AcceptOptionInput,
  AcceptOptionResult,
  AcceptOptionSuccess,
  CloudSession,
  GenerateInput,
  GenerateResult,
  PlanReview,
  ProjectListing,
  ProjectOverview,
  ProjectOverviewResult,
  RefOverview,
  ReviewOptionInput,
  ReviewOptionResult,
  ReviewOptionSuccess,
  RunSummary,
  Strategy,
  StudioStatus,
} from "./review.ts";

const strict = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const identifier = Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001f]+$" });
const revision = Type.Union([identifier, Type.Null()]);
const version = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const readParameters = strict({
  projectId: identifier,
  ref: Type.Optional(Type.String({ ...identifier, default: "main" })),
});
const envelope = {
  projectId: identifier,
  ref: identifier,
  baseRevision: revision,
  requestId: identifier,
};

function caller(ctx: ToolContext): Caller {
  return {
    role: ctx.role,
    namespace: ctx.namespace as string,
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
  };
}

/** Shape and topology are separate core contracts; never migrate or repair persisted reads. */
function model(value: unknown): Model {
  validateModel(value);
  const problems = checkModel(value);
  if (problems.length)
    throw new InputError("invalid_input", problems[0]?.detail ?? "Invalid model");
  return value;
}

function current(state: RefState) {
  const candidate = model(state.model);
  validateBrief(state.brief.body);
  return { model: candidate, brief: state.brief.body };
}

function metadataValidation<T>(action: () => T): T | Rejection {
  try {
    return action();
  } catch (error) {
    if (error instanceof InputError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

function bindings(
  candidate: Model,
  brief: Parameters<typeof bindingProblems>[1],
): Rejection | undefined {
  const problems = bindingProblems(candidate, brief);
  if (problems.length) return { ok: false, code: "invalid_binding", details: problems };
}

/** Acceptance preserves snapshots exactly, including issued and retired identity counters. */
function acceptanceEligibility(
  states: AcceptanceStates,
  main: Model,
  option: Model,
  evaluation: Scorecard,
  namespace: string,
  requestId: string,
): ReviewOptionSuccess["eligibility"] {
  if (states.source.forkBase?.revisionId !== states.main.revisionId)
    return { allowed: false, code: "stale_baseline" };
  for (const [kind, records, base] of [
    ["wall", option.walls, main.walls],
    ["opening", option.openings, main.openings],
    ["space", option.spaces, main.spaces],
  ] as const) {
    const existing = new Set(base.map((record) => record.id));
    if (
      option.next[kind] < main.next[kind] ||
      records.some(
        (record) => !existing.has(record.id) && Number(record.id.slice(1)) < main.next[kind],
      )
    )
      return { allowed: false, code: "invalid_identity" };
  }
  if (!evaluation.valid) return { allowed: false, code: "invalid_option" };
  const receipt: AcceptanceReceipt = {
    schemaVersion: 1,
    projectId: states.main.projectId,
    sourceRef: states.source.ref,
    sourceRevisionId: states.source.revisionId,
    briefVersion: states.main.brief.version,
    baselineRevisionId: states.main.revisionId,
    evaluatorVersion: evaluation.evaluatorVersion,
    previousMainRevisionId: states.main.revisionId,
    requestId,
    actor: { role: "owner", namespace },
    scorecard: evaluation,
  };
  if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_ACCEPTANCE_RECEIPT_BYTES)
    return { allowed: false, code: "score_too_large" };
  return { allowed: true };
}

/** Server-derived plan of one head, scored against the given brief and baseline. */
function planReview(
  state: RefState,
  candidate: Model,
  brief: ReturnType<typeof current>["brief"],
  base: Model,
): PlanReview {
  const { spaces, openings, adjacencies, slab, problems } = derive(candidate);
  return {
    revisionId: state.revisionId,
    model: candidate,
    derived: { spaces, openings, adjacencies, slab, problems },
    scorecard: scorecard(candidate, brief, base),
  };
}

function runSummary(ctx: ToolContext, run: RunRecord): RunSummary {
  const last = ctx.store?.readLastRunTurn(run.id);
  const transcript = (last?.transcript ?? null) as {
    kind?: unknown;
    name?: unknown;
    reason?: unknown;
  } | null;
  const valid = (run.evaluation?.result as { valid?: unknown } | undefined)?.valid;
  return {
    id: run.id,
    status: run.status,
    outcome: run.outcome,
    strategySeed: run.strategySeed,
    retryCount: run.retryCount,
    valid: typeof valid === "boolean" ? valid : null,
    spend: (last?.spend ?? null) as RunSummary["spend"],
    lastEvent:
      transcript && typeof transcript.kind === "string"
        ? {
            kind: transcript.kind,
            ...(typeof transcript.name === "string" ? { name: transcript.name } : {}),
            ...(typeof transcript.reason === "string" || transcript.reason === null
              ? { reason: transcript.reason as string | null }
              : {}),
          }
        : null,
  };
}

export const listProjects = defineTool({
  name: "list_projects",
  description: "Owner-only list of projects with their brief names and option counts.",
  parameters: strict({}),
  mutates: false,
  async execute(_params, ctx) {
    const store = ctx.store;
    if (!store) return result({ ok: false, code: "store_unavailable" });
    const listing: ProjectListing = {
      ok: true,
      projects: store.listProjects().map((project) => {
        const brief = store.readState(project.projectId, "main")?.brief.body as
          | { name?: unknown }
          | null
          | undefined;
        return {
          ...project,
          name: typeof brief?.name === "string" ? brief.name : null,
          options: store.listRefs(project.projectId).filter((ref) => ref.ref !== "main").length,
        };
      }),
    };
    return result(listing);
  },
});

export const projectOverview = defineTool({
  name: "project_overview",
  description:
    "Owner-only overview of main and every option ref: derived plans, fresh scorecards and agent run progress.",
  parameters: strict({ projectId: identifier }),
  mutates: false,
  async execute(params, ctx) {
    const store = ctx.store;
    if (!store) return result({ ok: false, code: "store_unavailable" });
    const mainState = store.readState(params.projectId, "main");
    if (!mainState) return result({ ok: false, code: "project_not_found" });
    const main = current(mainState);
    const runs = store.listRuns(params.projectId);
    const options = store
      .listRefs(params.projectId)
      .filter((ref) => ref.ref !== "main")
      .flatMap((ref): RefOverview[] => {
        const state = store.readState(params.projectId, ref.ref);
        if (!state) return [];
        const candidate = current(state);
        const base = state.forkBase ? model(state.forkBase.model) : candidate.model;
        return [
          {
            ref: ref.ref,
            forkBaseRevisionId: ref.forkBaseRevisionId,
            stale: ref.forkBaseRevisionId !== mainState.revisionId,
            // Same fresh evaluation an option review would show: current brief, own baseline.
            plan: planReview(state, candidate.model, main.brief, base),
            runs: runs.filter((run) => run.ref === ref.ref).map((run) => runSummary(ctx, run)),
          },
        ];
      });
    const overview: ProjectOverview = {
      ok: true,
      projectId: params.projectId,
      briefVersion: mainState.brief.version,
      brief: main.brief,
      main: planReview(mainState, main.model, main.brief, main.model),
      options,
    };
    return result(overview);
  },
});

export const reviewOption = defineTool({
  name: "review_option",
  description:
    "Coherent option review against current main and brief; requires owner or trusted project review capability.",
  parameters: strict({
    projectId: identifier,
    ref: Type.String({ ...identifier, not: { const: "main" } }),
  }),
  mutates: false,
  async execute(params, ctx) {
    const read = ctx.store?.readReview(params.projectId, params.ref);
    if (!read) return result({ ok: false, code: "store_unavailable" });
    if (!read.ok) return result(read);
    const { main, source } = read.states;
    const baseline = current(main);
    const candidate = current(source);
    if (!source.forkBase) return result({ ok: false, code: "stale_baseline" });
    // Validate persisted baseline data, but never use its historical score as acceptance evidence.
    model(source.forkBase.model);
    const mainReview = planReview(main, baseline.model, baseline.brief, baseline.model);
    const option = planReview(source, candidate.model, baseline.brief, baseline.model);
    const review: ReviewOptionSuccess = {
      ok: true,
      projectId: params.projectId,
      ref: params.ref,
      briefVersion: main.brief.version,
      baselineRevisionId: source.forkBase.revisionId,
      brief: baseline.brief,
      main: mainReview,
      option,
      // Review reserves the maximum bounded request-ID size; the store checks the actual receipt.
      eligibility: acceptanceEligibility(
        read.states,
        baseline.model,
        candidate.model,
        option.scorecard,
        ctx.namespace as string,
        "\ud800".repeat(128),
      ),
    };
    return result(review);
  },
});

export const acceptOption = defineTool({
  name: "accept_option",
  description:
    "Owner-only acceptance of an exactly pinned, freshly valid option snapshot into main.",
  parameters: strict({
    projectId: identifier,
    ref: Type.Literal("main"),
    baseRevision: identifier,
    requestId: identifier,
    body: strict({
      sourceRef: Type.String({ ...identifier, not: { const: "main" } }),
      sourceRevisionId: identifier,
      briefVersion: version,
      baselineRevisionId: identifier,
      evaluatorVersion: identifier,
    }),
  }),
  mutates: true,
  async execute(params, ctx) {
    const evaluate: AcceptanceEvaluator = (states) =>
      metadataValidation<ReturnType<AcceptanceEvaluator>>(() => {
        const baseline = current(states.main);
        const candidate = current(states.source);
        if (states.source.forkBase) model(states.source.forkBase.model);
        const evaluation = scorecard(candidate.model, baseline.brief, baseline.model);
        // This check belongs after store replay: evaluator upgrades must not invalidate exact retries.
        if (params.body.evaluatorVersion !== evaluation.evaluatorVersion)
          return { ok: false, code: "stale_evaluator" };
        const eligibility = acceptanceEligibility(
          states,
          baseline.model,
          candidate.model,
          evaluation,
          ctx.namespace as string,
          params.requestId,
        );
        if (!eligibility.allowed)
          return {
            ok: false,
            code: eligibility.code,
            ...(eligibility.code === "invalid_option"
              ? { details: evaluation.gates.filter((gate) => !gate.passed) }
              : {}),
          };
        return {
          ok: true,
          evaluation: { evaluatorVersion: evaluation.evaluatorVersion, result: evaluation },
        };
      });
    const outcome = ctx.store?.execute({ ...params, type: "accept_option" }, caller(ctx), evaluate);
    return result(outcome as NonNullable<typeof outcome>);
  },
});

export const inspectProject = defineTool({
  name: "inspect_project",
  description:
    "Summarise a project: walls, openings, spaces and the current head revision of a ref.",
  parameters: readParameters,
  mutates: false,
  async execute(params, ctx) {
    const state = ctx.store?.readState(params.projectId, params.ref ?? "main");
    if (!state) return result({ ok: false, code: "ref_not_found" });
    const { model, brief } = current(state);
    const { spaces, openings, adjacencies, slab, problems } = derive(model);
    return result({
      ok: true,
      projectId: state.projectId,
      ref: state.ref,
      revisionId: state.revisionId,
      briefVersion: state.brief.version,
      baselineRevisionId: state.forkBase?.revisionId ?? null,
      model,
      brief,
      derived: { spaces, openings, adjacencies, slab, problems },
    });
  },
});

/**
 * Synchronous fresh score of one persisted ref head, pinned to exactly the state it read. Shared by
 * the scorecard tool and trusted workflow code that must score without yielding to the event loop.
 */
export function scoreState(state: RefState) {
  const candidate = current(state);
  const base = state.forkBase ? model(state.forkBase.model) : candidate.model;
  const evaluation = scorecard(candidate.model, candidate.brief, base);
  return {
    ok: true as const,
    revisionId: state.revisionId,
    briefVersion: state.brief.version,
    baselineRevisionId: state.forkBase?.revisionId ?? null,
    evaluatorVersion: evaluation.evaluatorVersion,
    result: evaluation,
  };
}

export const scorecardTool = defineTool({
  name: "scorecard",
  description: "Evaluate the current option against the current brief and immutable fork baseline.",
  parameters: readParameters,
  mutates: false,
  async execute(params, ctx) {
    const state = ctx.store?.readState(params.projectId, params.ref ?? "main");
    if (!state) return result({ ok: false, code: "ref_not_found" });
    return result(scoreState(state));
  },
});

export const applyChangesTool = defineTool({
  name: "apply_changes",
  description: "Atomically apply core operations with explicit current brief and baseline pins.",
  parameters: strict({
    ...envelope,
    body: strict({ ops: OpsSchema, briefVersion: version, baselineRevisionId: revision }),
  }),
  mutates: true,
  async execute(params, ctx) {
    const outcome = ctx.store?.execute({ ...params, type: "apply_changes" }, caller(ctx), (state) =>
      metadataValidation<Evaluation>(() => {
        if (params.body.briefVersion !== state.brief.version)
          return { ok: false, code: "stale_brief" };
        if (params.body.baselineRevisionId !== (state.forkBase?.revisionId ?? null))
          return { ok: false, code: "stale_baseline" };
        const candidate = current(state);
        const applied = applyChanges(candidate.model, params.body.ops, ctx.role, candidate.brief);
        if (!applied.ok)
          return {
            ok: false,
            code: applied.rejection.reason,
            message: applied.rejection.detail,
            details: applied.rejection,
          };
        return { ok: true, model: applied.model, effects: applied.effects };
      }),
    );
    return result(outcome as NonNullable<typeof outcome>);
  },
});

export const createProject = defineTool({
  name: "create_project",
  description:
    "Owner-only creation of a v2 main model and brief; supplied identities are preserved.",
  parameters: strict({ ...envelope, body: strict({ model: ModelSchema, brief: BriefSchema }) }),
  mutates: true,
  async execute(params, ctx) {
    const command = { ...params, type: "create_project" as const, body: { ...params.body } };
    const outcome = ctx.store?.execute(command, caller(ctx), undefined, () =>
      metadataValidation<Rejection | undefined>(() => {
        if (params.ref !== "main") return { ok: false, code: "invalid_ref" };
        validateModel(command.body.model);
        validateBrief(command.body.brief);
        const problems = checkModel(command.body.model).filter(
          (p) => p.code !== "space_mismatch" || p.subjects.length > 0,
        );
        if (problems.length) return { ok: false, code: "invalid_geometry", details: problems };
        const canonical = applyChanges(command.body.model, [], "owner", command.body.brief);
        if (!canonical.ok)
          return { ok: false, code: canonical.rejection.reason, details: canonical.rejection };
        // Missing face records may be derived; no supplied record or issued counter may be retired.
        if (canonical.effects.some((e) => e.kind === "space_retired"))
          return { ok: false, code: "invalid_geometry", message: "Creation would retire identity" };
        command.body.model = canonical.model;
        return bindings(canonical.model, command.body.brief);
      }),
    );
    return result(outcome as NonNullable<typeof outcome>);
  },
});

export const forkRef = defineTool({
  name: "fork_ref",
  description: "Owner-only fork with its source head pinned as an immutable baseline.",
  parameters: strict({ ...envelope, body: strict({ sourceRef: identifier }) }),
  mutates: true,
  async execute(params, ctx) {
    const outcome = ctx.store?.execute(
      { ...params, type: "fork_ref" },
      caller(ctx),
      undefined,
      (state) =>
        metadataValidation<Rejection | undefined>(() => {
          if (params.ref === "main") return { ok: false, code: "invalid_ref" };
          const candidate = current(state as RefState);
          return bindings(candidate.model, candidate.brief);
        }),
    );
    return result(outcome as NonNullable<typeof outcome>);
  },
});

export const setBrief = defineTool({
  name: "set_brief",
  description:
    "Owner-only brief edit. Preserve logical requirement IDs; retired IDs cannot return.",
  parameters: strict({
    ...envelope,
    baseBriefVersion: version,
    body: strict({ brief: BriefSchema }),
  }),
  mutates: true,
  async execute(params, ctx) {
    const outcome = ctx.store?.execute(
      {
        ...params,
        type: "set_brief",
        body: { ...params.body, baseBriefVersion: params.baseBriefVersion },
      },
      caller(ctx),
      undefined,
      (state) =>
        metadataValidation<Rejection | undefined>(() => {
          validateBrief(params.body.brief);
          const candidate = current(state as RefState);
          const active = new Set(candidate.brief.rooms.map((r) => r.id));
          const history = ctx.store?.readBriefs(params.projectId) ?? [];
          const retired = new Set<string>();
          for (const entry of history) {
            // Historical v1 documents have no stable requirement IDs; leave them untouched.
            if ((entry.body as { schemaVersion?: unknown } | null)?.schemaVersion !== 2) continue;
            validateBrief(entry.body);
            for (const room of entry.body.rooms) if (!active.has(room.id)) retired.add(room.id);
          }
          for (const room of params.body.brief.rooms)
            if (retired.has(room.id))
              return { ok: false, code: "retired_requirement", message: `Retired ID ${room.id}` };
          return bindings(candidate.model, params.body.brief);
        }),
    );
    return result(outcome as NonNullable<typeof outcome>);
  },
});

export const tools: readonly ToolDefinition[] = [
  inspectProject,
  scorecardTool,
  applyChangesTool,
  createProject,
  forkRef,
  setBrief,
  reviewOption,
  acceptOption,
  listProjects,
  projectOverview,
];
