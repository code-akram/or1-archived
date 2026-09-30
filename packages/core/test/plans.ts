import {
  type ApplyResult,
  applyChanges,
  type Derived,
  emptyModel,
  type Model,
  type Op,
  type Role,
  type SpaceId,
  spaceAt,
} from "../src/index.ts";

/** Exterior and partition thicknesses used across fixtures. */
export const EXT = 200;
export const PART = 100;

type Flags = { locked?: boolean; structural?: boolean };

export function wall(
  a: readonly [number, number],
  b: readonly [number, number],
  thickness: number = PART,
  flags: Flags = {},
): Op {
  return {
    op: "add_wall",
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
    thickness,
    ...flags,
  };
}

/** Four walls around a rectangle, counter-clockwise from the bottom-left: bottom, right, top, left. */
export function box(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number = EXT,
  flags: Flags = {},
): Op[] {
  return [
    wall([x0, y0], [x1, y0], thickness, flags),
    wall([x1, y0], [x1, y1], thickness, flags),
    wall([x1, y1], [x0, y1], thickness, flags),
    wall([x0, y1], [x0, y0], thickness, flags),
  ];
}

export type Applied = Extract<ApplyResult, { ok: true }>;

/** Applies ops and fails the test with the rejection if they are not accepted. */
export function accept(model: Model, ops: readonly Op[], role: Role = "agent"): Applied {
  const result = applyChanges(model, ops, role);
  if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result.rejection, null, 2)}`);
  return result;
}

/** Builds a model from scratch through the one write path, as the owner. */
export function build(ops: readonly Op[]): Applied {
  return accept(emptyModel(), ops, "owner");
}

export function spaceIdAt(derived: Derived, x: number, y: number): SpaceId {
  const ref = spaceAt(derived, { x, y });
  if (!ref || ref === "exterior") throw new Error(`no space at (${x}, ${y})`);
  return ref;
}

export function netAreaOf(derived: Derived, id: SpaceId): number {
  const space = derived.spaces.find((s) => s.id === id);
  if (!space) throw new Error(`no space ${id}`);
  return space.netArea;
}
