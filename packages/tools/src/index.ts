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
  scorecard,
  validateBrief,
  validateModel,
} from "@or1/core";
import type { Caller, Evaluation, RefState, Rejection } from "@or1/store";
import { type TSchema, Type } from "typebox";
import { defineTool, result, type ToolContext, type ToolDefinition } from "./registry.ts";

export type { ToolContext, ToolDefinition, ToolResult } from "./registry.ts";
export { defineTool, MAX_TOOL_INPUT_BYTES } from "./registry.ts";

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

export const scorecardTool = defineTool({
  name: "scorecard",
  description: "Evaluate the current option against the current brief and immutable fork baseline.",
  parameters: readParameters,
  mutates: false,
  async execute(params, ctx) {
    const state = ctx.store?.readState(params.projectId, params.ref ?? "main");
    if (!state) return result({ ok: false, code: "ref_not_found" });
    const candidate = current(state);
    const base = state.forkBase ? model(state.forkBase.model) : candidate.model;
    const evaluation = scorecard(candidate.model, candidate.brief, base);
    return result({
      ok: true,
      revisionId: state.revisionId,
      briefVersion: state.brief.version,
      baselineRevisionId: state.forkBase?.revisionId ?? null,
      evaluatorVersion: evaluation.evaluatorVersion,
      result: evaluation,
    });
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
];
