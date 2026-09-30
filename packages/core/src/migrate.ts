import { Value } from "typebox/value";
import { type Brief, LegacyBriefSchema, validateBrief } from "./brief.ts";
import { checkModel } from "./derive.ts";
import { LegacyModelSchema, type Model, validateModel } from "./model.ts";

/** Explicit import only: never rewrites a historical document. Repeated programs require review. */
export function migrateV1(
  model: unknown,
  brief: unknown,
):
  | { ok: true; model: Model; brief: Brief }
  | { ok: false; code: "review_required" | "invalid_legacy"; detail: string } {
  if (!Value.Check(LegacyModelSchema, model) || !Value.Check(LegacyBriefSchema, brief)) {
    return { ok: false, code: "invalid_legacy", detail: "invalid v1 model or brief" };
  }
  if (new Set(brief.rooms.map((r) => r.program)).size !== brief.rooms.length) {
    return {
      ok: false,
      code: "review_required",
      detail: "repeated-program v1 requirements cannot be allocated safely",
    };
  }
  const rooms = brief.rooms.map(({ count, ...r }, i) => ({
    ...r,
    id: `r${i + 1}`,
    quantity: count ?? 1,
  }));
  const { constraints: oldConstraints, ...rest } = brief;
  const migrated: Brief = {
    ...rest,
    schemaVersion: 2,
    rooms,
    constraints: oldConstraints.map((c) => {
      if (c.kind === "adjacent")
        return {
          ...c,
          a: { kind: "program" as const, program: c.a },
          b: { kind: "program" as const, program: c.b },
        };
      const { program, ...attributes } = c;
      return { ...attributes, target: { kind: "program" as const, program } };
    }),
  };
  const byProgram = new Map(rooms.map((r) => [r.program, r.id]));
  const candidate: Model = {
    ...model,
    schemaVersion: 2,
    spaces: model.spaces.map((s) => {
      const requirementId = s.program ? byProgram.get(s.program) : undefined;
      return { ...s, ...(requirementId ? { requirementId } : {}) };
    }),
  };
  validateModel(candidate);
  validateBrief(migrated);
  if (checkModel(candidate).length)
    return { ok: false, code: "invalid_legacy", detail: "legacy geometry is inconsistent" };
  return { ok: true, model: candidate, brief: migrated };
}
