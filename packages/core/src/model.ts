import { type Static, type TSchema, Type } from "typebox";

/**
 * The persisted model. Walls and openings are authoritative; spaces are persistent records whose
 * geometry is derived from the walls (see derive.ts). Schemas are the single definition: TS types are
 * derived from them, and the tool registry reuses them for tool parameters.
 * The rules these values must satisfy are in docs/geometry-contract.md.
 */

const id = <T extends string>(prefix: string) =>
  Type.Unsafe<T>(Type.String({ pattern: `^${prefix}[1-9][0-9]*$` }));

export const WallIdSchema = id<`W${number}`>("W");
export const OpeningIdSchema = id<`O${number}`>("O");
export const SpaceIdSchema = id<`S${number}`>("S");

export type WallId = Static<typeof WallIdSchema>;
export type OpeningId = Static<typeof OpeningIdSchema>;
export type SpaceId = Static<typeof SpaceIdSchema>;
export type RevisionId = string;

/** Integer millimetres. All stored geometry uses this unit. */
export const MmSchema = Type.Integer({ description: "integer millimetres" });
export type Mm = number;

export const PointSchema = strict({ x: MmSchema, y: MmSchema });
export type Point = Static<typeof PointSchema>;

/** A straight, orthogonal wall. Coordinates are its centreline. */
export const WallSchema = strict({
  id: WallIdSchema,
  start: PointSchema,
  end: PointSchema,
  thickness: MmSchema,
  locked: Type.Boolean(),
  structural: Type.Boolean(),
});
export type Wall = Static<typeof WallSchema>;

const hosted = {
  /** Host wall. The opening lies fully within one segment of it. */
  wall: WallIdSchema,
  /** Distance along the host from its start point to the opening's near edge. */
  offset: MmSchema,
  width: MmSchema,
  locked: Type.Boolean(),
};

export const DoorSchema = strict({
  id: OpeningIdSchema,
  kind: Type.Literal("door"),
  ...hosted,
  /** Jamb the leaf hangs on, relative to the host's start → end direction. */
  hinge: Type.Union([Type.Literal("start"), Type.Literal("end")]),
  /** Side of the host the leaf swings into, looking from start to end. */
  swing: Type.Union([Type.Literal("left"), Type.Literal("right")]),
  /** The unit's entrance. Reachability is measured from here. */
  entrance: Type.Boolean(),
});
export const WindowSchema = strict({
  id: OpeningIdSchema,
  kind: Type.Literal("window"),
  ...hosted,
});
export const OpeningSchema = Type.Union([DoorSchema, WindowSchema]);
export type Door = Static<typeof DoorSchema>;
export type Window = Static<typeof WindowSchema>;
export type Opening = Static<typeof OpeningSchema>;

/** Programme tags are snake_case keys shared with the brief, e.g. `bedroom`, `corridor`. */
export const ProgramSchema = Type.String({ pattern: "^[a-z][a-z0-9_]*$", maxLength: 64 });
export const LabelSchema = Type.String({ minLength: 1, maxLength: 80 });

/**
 * A persistent space record. `anchor` is derived state kept so the record can be matched to its face:
 * a point strictly inside the face, rewritten by apply_changes after every edit.
 */
export const SpaceRecordSchema = strict({
  id: SpaceIdSchema,
  anchor: PointSchema,
  label: Type.Optional(LabelSchema),
  program: Type.Optional(ProgramSchema),
});
export type SpaceRecord = Static<typeof SpaceRecordSchema>;

/** Next numeric suffix per ID kind. IDs are never reused, so a stale reference cannot hit a new element. */
export const CountersSchema = strict({
  wall: Type.Integer({ minimum: 1 }),
  opening: Type.Integer({ minimum: 1 }),
  space: Type.Integer({ minimum: 1 }),
});

export const ModelSchema = strict({
  schemaVersion: Type.Literal(1),
  walls: Type.Array(WallSchema),
  openings: Type.Array(OpeningSchema),
  spaces: Type.Array(SpaceRecordSchema),
  next: CountersSchema,
});
export type Model = Static<typeof ModelSchema>;

export function emptyModel(): Model {
  return {
    schemaVersion: 1,
    walls: [],
    openings: [],
    spaces: [],
    next: { wall: 1, opening: 1, space: 1 },
  };
}

/** Numeric part of an element ID, e.g. 42 for `W42`. */
export function idNumber(value: string): number {
  return Number(value.slice(1));
}

function strict<P extends Record<string, TSchema>>(properties: P) {
  return Type.Object(properties, { additionalProperties: false });
}
