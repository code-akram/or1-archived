import { type Static, type TSchema, Type } from "typebox";
import {
  LabelSchema,
  MmSchema,
  OpeningIdSchema,
  PointSchema,
  ProgramSchema,
  SpaceIdSchema,
  WallIdSchema,
} from "./model.ts";

/**
 * The typed operations apply_changes accepts (geometry contract, "Edit operations"). A batch is atomic:
 * ops run in order on a private draft, then the complete candidate is checked once.
 */

const op = <N extends string, P extends Record<string, TSchema>>(name: N, properties: P) =>
  Type.Object({ op: Type.Literal(name), ...properties }, { additionalProperties: false });

const optionalFlag = Type.Optional(Type.Boolean());
const nullable = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));

export const AddWallSchema = op("add_wall", {
  id: Type.Optional(WallIdSchema),
  start: PointSchema,
  end: PointSchema,
  thickness: MmSchema,
  locked: optionalFlag,
  structural: optionalFlag,
});
export const RemoveWallSchema = op("remove_wall", { id: WallIdSchema });
export const MoveWallSchema = op("move_wall", {
  id: WallIdSchema,
  /** Perpendicular translation: along +x for a vertical wall, along +y for a horizontal one. */
  by: MmSchema,
});
export const ResizeWallSchema = op("resize_wall", {
  id: WallIdSchema,
  start: PointSchema,
  end: PointSchema,
});
export const UpdateWallSchema = op("update_wall", {
  id: WallIdSchema,
  thickness: Type.Optional(MmSchema),
  locked: optionalFlag,
  structural: optionalFlag,
});
const openingPlacement = {
  wall: WallIdSchema,
  offset: MmSchema,
  width: MmSchema,
  locked: optionalFlag,
};
const Hinge = Type.Union([Type.Literal("start"), Type.Literal("end")]);
const Swing = Type.Union([Type.Literal("left"), Type.Literal("right")]);
export const AddDoorSchema = op("add_door", {
  id: Type.Optional(OpeningIdSchema),
  ...openingPlacement,
  hinge: Type.Optional(Hinge),
  swing: Type.Optional(Swing),
  entrance: optionalFlag,
});
export const AddWindowSchema = op("add_window", {
  id: Type.Optional(OpeningIdSchema),
  ...openingPlacement,
});
export const UpdateOpeningSchema = op("update_opening", {
  id: OpeningIdSchema,
  offset: Type.Optional(MmSchema),
  width: Type.Optional(MmSchema),
  locked: optionalFlag,
  hinge: Type.Optional(Hinge),
  swing: Type.Optional(Swing),
  entrance: optionalFlag,
});
export const RemoveOpeningSchema = op("remove_opening", { id: OpeningIdSchema });
export const TagSpaceSchema = op("tag_space", {
  /** A space ID, or a point inside the space's clear floor. Resolved against the batch's final geometry. */
  space: Type.Union([SpaceIdSchema, PointSchema]),
  /** Omit to keep, null to clear. */
  label: nullable(LabelSchema),
  program: nullable(ProgramSchema),
});

export const OpSchema = Type.Union([
  AddWallSchema,
  RemoveWallSchema,
  MoveWallSchema,
  ResizeWallSchema,
  UpdateWallSchema,
  AddDoorSchema,
  AddWindowSchema,
  UpdateOpeningSchema,
  RemoveOpeningSchema,
  TagSpaceSchema,
]);
export const OpsSchema = Type.Array(OpSchema);

export type Op = Static<typeof OpSchema>;
export type TagSpaceOp = Static<typeof TagSpaceSchema>;
