import { type Static, type TSchema, Type } from "typebox";
import { ProgramSchema } from "./model.ts";

/**
 * The brief: what a test-fit must contain. Every requirement is marked `hard` (a gate: the option is
 * invalid if it fails) or soft (scored, never traded against a gate). Rooms match spaces by their
 * `program` tag. Lengths are millimetres; areas are square metres of clear floor (net area).
 * See docs/brief-and-scorecard.md.
 */

const strict = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const constraint = <K extends string, P extends Record<string, TSchema>>(kind: K, properties: P) =>
  strict({ kind: Type.Literal(kind), ...properties, hard: Type.Boolean() });

const AreaM2 = Type.Number({ exclusiveMinimum: 0, description: "square metres of clear floor" });
const Width = Type.Integer({ minimum: 1, description: "millimetres" });

export const RoomSchema = strict({
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

export const ConstraintSchema = Type.Union([
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

export const BriefSchema = strict({
  schemaVersion: Type.Literal(1),
  name: Type.Optional(Type.String({ maxLength: 120 })),
  rooms: Type.Array(RoomSchema),
  constraints: Type.Array(ConstraintSchema),
  /** Programs held to the corridor width gate. Default: corridor, hall. */
  circulation: Type.Optional(Type.Array(ProgramSchema)),
  /** Programs exempt from the reachability gate, such as shafts. Default: shaft. */
  unreachable: Type.Optional(Type.Array(ProgramSchema)),
  thresholds: Type.Optional(ThresholdsSchema),
});

export type Room = Static<typeof RoomSchema>;
export type Constraint = Static<typeof ConstraintSchema>;
export type Brief = Static<typeof BriefSchema>;

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
