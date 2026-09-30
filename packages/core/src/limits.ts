import type { Model, Wall } from "./model.ts";

/** Conservative first-workflow envelope, not a production capacity promise. */
export const LIMITS = {
  coordinate: 1_000_000,
  dimension: 2_000_000,
  id: 1_000_000,
  walls: 128,
  openings: 256,
  spaces: 256,
  operations: 256,
  requirements: 128,
  quantity: 128,
  constraints: 256,
  gridCells: 65_536,
  segments: 512,
  widthRectangles: 2_000_000,
} as const;

export class InputError extends Error {
  readonly code: "invalid_input" | "limit_exceeded";
  constructor(code: "invalid_input" | "limit_exceeded", message: string) {
    super(message);
    this.name = "InputError";
    this.code = code;
  }
}

export function limit(condition: boolean, detail: string): void {
  if (!condition) throw new InputError("limit_exceeded", detail);
}

export function wallLimits(walls: readonly Wall[]): void {
  limit(walls.length <= LIMITS.walls, "too many walls");
  for (const w of walls) {
    for (const p of [w.start, w.end]) {
      limit(Number.isSafeInteger(p.x) && Math.abs(p.x) <= LIMITS.coordinate, "X coordinate limit");
      limit(Number.isSafeInteger(p.y) && Math.abs(p.y) <= LIMITS.coordinate, "Y coordinate limit");
    }
    limit(
      Number.isSafeInteger(w.thickness) && Math.abs(w.thickness) <= LIMITS.dimension,
      "thickness limit",
    );
  }
}

export function modelLimits(model: Model): void {
  wallLimits(model.walls);
  limit(model.openings.length <= LIMITS.openings, "too many openings");
  limit(model.spaces.length <= LIMITS.spaces, "too many spaces");
  for (const item of [...model.walls, ...model.openings, ...model.spaces]) {
    const n = Number(item.id.slice(1));
    limit(Number.isSafeInteger(n) && n > 0 && n < LIMITS.id, "element ID limit");
  }
  for (const n of Object.values(model.next)) {
    limit(Number.isSafeInteger(n) && n > 0 && n <= LIMITS.id, "counter limit");
  }
  for (const s of model.spaces) {
    for (const n of [s.anchor.x, s.anchor.y])
      limit(Number.isSafeInteger(n) && Math.abs(n) <= LIMITS.coordinate, "anchor coordinate limit");
  }
  for (const o of model.openings) {
    for (const n of [o.offset, o.width]) {
      limit(Number.isSafeInteger(n) && Math.abs(n) <= LIMITS.dimension, "opening dimension limit");
    }
  }
}
