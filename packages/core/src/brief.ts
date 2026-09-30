import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { canonical } from "./equal.ts";
import { InputError, LIMITS, limit } from "./limits.ts";
import { type Model, ProgramSchema, RequirementIdSchema } from "./model.ts";

/**
 * The brief: what a test-fit must contain. Every requirement is marked `hard` (a gate: the option is
 * invalid if it fails) or soft (scored, never traded against a gate). Rooms match explicit
 * requirement assignments and matching programs. Lengths are millimetres; areas are square metres of clear floor (net area).
 * See docs/brief-and-scorecard.md.
 */

const strict = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const constraint = <K extends string, P extends Record<string, TSchema>>(kind: K, properties: P) =>
  strict({ kind: Type.Literal(kind), ...properties, hard: Type.Boolean() });

const AreaM2 = Type.Number({ exclusiveMinimum: 0, description: "square metres of clear floor" });
const Width = Type.Integer({ minimum: 1, description: "millimetres" });

export const LegacyRoomSchema = strict({
  program: ProgramSchema,
  /** How many spaces with this program. Default 1. */
  count: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Hard: presence is a gate. Soft: presence is scored. */
  hard: Type.Boolean(),
  /** Target clear area per space. Always soft: scored by relative deviation. */
  targetAreaM2: Type.Optional(AreaM2),
  /** Habitable rooms are scored for daylight: a window on a wall facing the exterior. */
  habitable: Type.Optional(Type.Boolean()),
});

export const LegacyConstraintSchema = Type.Union([
  /** Every space with this program has at least this clear area. */
  constraint("min_area", { program: ProgramSchema, areaM2: AreaM2 }),
  constraint("max_area", { program: ProgramSchema, areaM2: AreaM2 }),
  /** Every space with this program is at least this wide everywhere (clear, between wall faces). */
  constraint("min_width", { program: ProgramSchema, width: Width }),
  /**
   * Every space with program `a` touches a space with program `b`: through a shared wall (`wall`) or
   * a door between them (`door`).
   */
  constraint("adjacent", {
    a: ProgramSchema,
    b: ProgramSchema,
    via: Type.Union([Type.Literal("wall"), Type.Literal("door")]),
  }),
  /** Every space with this program has a window on a wall facing the exterior. */
  constraint("daylight", { program: ProgramSchema }),
]);

export const ThresholdsSchema = strict({
  corridorWidth: Type.Optional(Width),
  doorWidth: Type.Optional(Width),
  entranceDoorWidth: Type.Optional(Width),
});

const briefProperties = {
  name: Type.Optional(Type.String({ maxLength: 120 })),
  circulation: Type.Optional(Type.Array(ProgramSchema)),
  unreachable: Type.Optional(Type.Array(ProgramSchema)),
  thresholds: Type.Optional(ThresholdsSchema),
};
export const LegacyBriefSchema = strict({
  schemaVersion: Type.Literal(1),
  ...briefProperties,
  rooms: Type.Array(LegacyRoomSchema),
  constraints: Type.Array(LegacyConstraintSchema),
});
export const RoomSchema = strict({
  id: RequirementIdSchema,
  program: ProgramSchema,
  quantity: Type.Integer({ minimum: 1, maximum: LIMITS.quantity }),
  hard: Type.Boolean(),
  targetAreaM2: Type.Optional(AreaM2),
  habitable: Type.Optional(Type.Boolean()),
});
export const TargetSchema = Type.Union([
  strict({ kind: Type.Literal("program"), program: ProgramSchema }),
  strict({ kind: Type.Literal("requirement"), id: RequirementIdSchema }),
]);
export const ConstraintSchema = Type.Union([
  constraint("min_area", { target: TargetSchema, areaM2: AreaM2 }),
  constraint("max_area", { target: TargetSchema, areaM2: AreaM2 }),
  constraint("min_width", { target: TargetSchema, width: Width }),
  constraint("daylight", { target: TargetSchema }),
  constraint("adjacent", {
    a: TargetSchema,
    b: TargetSchema,
    via: Type.Union([Type.Literal("wall"), Type.Literal("door")]),
  }),
]);
export const BriefSchema = strict({
  schemaVersion: Type.Literal(2),
  ...briefProperties,
  rooms: Type.Array(RoomSchema, { maxItems: LIMITS.requirements }),
  constraints: Type.Array(ConstraintSchema, { maxItems: LIMITS.constraints }),
});

export type Room = Static<typeof RoomSchema>;
export type Constraint = Static<typeof ConstraintSchema>;
export type Brief = Static<typeof BriefSchema>;
export type Target = Static<typeof TargetSchema>;

/** Cross-row/reference validation belongs to the shared core, not adapter copies. */
export function validateBrief(value: unknown): asserts value is Brief {
  if (!Value.Check(BriefSchema, value)) throw new InputError("invalid_input", "invalid v2 brief");
  const ids = new Set<string>();
  const specifications = new Set<string>();
  let quantity = 0;
  for (const room of value.rooms) {
    if (ids.has(room.id))
      throw new InputError("invalid_input", `duplicate requirement ID ${room.id}`);
    ids.add(room.id);
    quantity += room.quantity;
    const constraints = value.constraints.filter((c) =>
      targets(c).some((t) => t.kind === "requirement" && t.id === room.id),
    );
    const normalized = [
      ...new Set(
        constraints.map((c) =>
          canonical(
            JSON.parse(
              JSON.stringify(c, (key, v) => (key === "id" && v === room.id ? "$self" : v)),
            ),
          ),
        ),
      ),
    ].sort();
    const spec = JSON.stringify([
      room.program,
      room.quantity,
      room.hard,
      room.targetAreaM2 ?? null,
      room.habitable ?? false,
      normalized,
    ]);
    if (specifications.has(spec))
      throw new InputError("invalid_input", `duplicate requirement specification ${room.id}`);
    specifications.add(spec);
  }
  limit(quantity <= LIMITS.spaces, "total requirement quantity limit");
  for (const c of value.constraints) {
    for (const t of targets(c)) {
      if (t.kind === "requirement" && !ids.has(t.id))
        throw new InputError("invalid_input", `unknown requirement ${t.id}`);
    }
    if ("width" in c) limit(c.width <= LIMITS.dimension, "constraint width limit");
    if ("areaM2" in c) limit(c.areaM2 <= 4_000_000, "constraint area limit");
  }
  for (const room of value.rooms)
    if (room.targetAreaM2 !== undefined) limit(room.targetAreaM2 <= 4_000_000, "target area limit");
  for (const width of Object.values(value.thresholds ?? {}))
    limit(width <= LIMITS.dimension, "threshold limit");
  limit(
    (value.circulation?.length ?? 0) <= LIMITS.requirements &&
      (value.unreachable?.length ?? 0) <= LIMITS.requirements,
    "program list limit",
  );
}

function targets(c: Constraint): Target[] {
  return c.kind === "adjacent" ? [c.a, c.b] : [c.target];
}

export function bindingProblems(
  model: Model,
  brief: Brief,
): { detail: string; subjects: string[] }[] {
  const rooms = new Map(brief.rooms.map((r) => [r.id, r]));
  return model.spaces.flatMap((s) => {
    if (!s.requirementId) return [];
    const room = rooms.get(s.requirementId);
    if (room && room.program === s.program) return [];
    return [
      {
        detail: `${s.id}: unknown or program-mismatched requirement ${s.requirementId}`,
        subjects: [s.id, s.requirementId],
      },
    ];
  });
}

/** Gate thresholds when the brief does not override them, in millimetres. */
export const DEFAULT_THRESHOLDS = {
  /** Clear corridor width. */
  corridorWidth: 900,
  /** Structural opening width of internal doors. */
  doorWidth: 800,
  entranceDoorWidth: 900,
} as const;

export const DEFAULT_CIRCULATION = ["corridor", "hall"] as const;
export const DEFAULT_UNREACHABLE = ["shaft"] as const;
