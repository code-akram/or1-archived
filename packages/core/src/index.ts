export type { ApplyResult, Effect, Rejection, Role } from "./apply-changes.ts";
export { applyChanges } from "./apply-changes.ts";
export type { Brief, Constraint, Room, Target } from "./brief.ts";
export {
  BriefSchema,
  bindingProblems,
  ConstraintSchema,
  DEFAULT_CIRCULATION,
  DEFAULT_THRESHOLDS,
  DEFAULT_UNREACHABLE,
  RoomSchema,
  TargetSchema,
  validateBrief,
} from "./brief.ts";
export { GEOMETRY } from "./contract.ts";
export type { Adjacency, Derived, DerivedSpace, OpeningSides, SpaceRef } from "./derive.ts";
export { checkModel, derive, narrowPart, spaceAt } from "./derive.ts";
export type { Junction, JunctionKind, Problem, ProblemCode } from "./geometry.ts";
export { wallProblems } from "./geometry.ts";
export type { Ring } from "./grid.ts";
export type { SpaceEffect } from "./identity.ts";
export { InputError, LIMITS } from "./limits.ts";
export { migrateV1 } from "./migrate.ts";
export type {
  Door,
  Mm,
  Model,
  Opening,
  OpeningId,
  Point,
  RevisionId,
  SpaceId,
  SpaceRecord,
  Wall,
  WallId,
  Window,
} from "./model.ts";
export {
  emptyModel,
  ModelSchema,
  OpeningSchema,
  PointSchema,
  validateModel,
  WallSchema,
} from "./model.ts";
export type { Op } from "./ops.ts";
export { OpSchema, OpsSchema } from "./ops.ts";
export type {
  ConstraintResult,
  Finding,
  GateName,
  GateResult,
  Scorecard,
  ScoreName,
  ScoreResult,
} from "./scorecard.ts";
export { GATES, scorecard } from "./scorecard.ts";
