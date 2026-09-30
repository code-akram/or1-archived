import { Value } from "typebox/value";
import { type Derived, derive, spaceAt } from "./derive.ts";
import { equal } from "./equal.ts";
import { type Problem, wallAxis, wallDirection } from "./geometry.ts";
import { reconcileSpaces, type SpaceEffect } from "./identity.ts";
import {
  type Door,
  idNumber,
  type Model,
  type Opening,
  type OpeningId,
  type Point,
  type SpaceId,
  type SpaceRecord,
  type Wall,
  type WallId,
} from "./model.ts";
import { type Op, OpSchema, type TagSpaceOp } from "./ops.ts";

/** Caller roles, assigned from credentials by each adapter. See tech-stack: Protection and permissions. */
export type Role = "owner" | "agent" | "external";

/** What a batch did besides its direct edits. `op` is the index of the op that caused it. */
export type Effect =
  | { readonly kind: "wall_added"; readonly wall: WallId; readonly op: number }
  | { readonly kind: "opening_added"; readonly opening: OpeningId; readonly op: number }
  | {
      readonly kind: "wall_stretched";
      readonly wall: WallId;
      readonly by: WallId;
      readonly op: number;
    }
  | {
      readonly kind: "opening_removed";
      readonly opening: OpeningId;
      readonly host: WallId;
      readonly op: number;
    }
  | SpaceEffect
  | {
      readonly kind: "space_area_changed";
      readonly space: SpaceId;
      /** Net area before and after, mm². */
      readonly from: number;
      readonly to: number;
    };

export type Rejection = {
  readonly reason: "invalid_op" | "not_found" | "forbidden" | "invalid_geometry";
  readonly detail: string;
  /** Index of the op at fault, when one op is. */
  readonly op?: number;
  readonly problems?: readonly Problem[];
};

export type ApplyResult =
  | {
      readonly ok: true;
      readonly model: Model;
      readonly derived: Derived;
      readonly effects: readonly Effect[];
    }
  | { readonly ok: false; readonly rejection: Rejection };

/**
 * Evaluates a batch of ops against an isolated candidate and returns the new model or a rejection.
 * The input model is never modified. Pure: revision checks, request IDs and persistence belong to the
 * store. Order: schema → ops on a draft → role policy on the complete candidate → space identity →
 * contract check → space tags.
 */
export function applyChanges(model: Model, ops: readonly Op[], role: Role): ApplyResult {
  for (const [index, op] of ops.entries()) {
    const problem = schemaProblem(op);
    if (problem) return reject("invalid_op", `op ${index}: ${problem}`, index);
  }

  const draft: Draft = {
    walls: new Map(model.walls.map((w) => [w.id, w])),
    openings: new Map(model.openings.map((o) => [o.id, o])),
    next: { ...model.next },
    effects: [],
    tags: [],
    cause: new Map(),
  };
  for (const [index, op] of ops.entries()) {
    const failure = execute(draft, op, index);
    if (failure) return reject(failure.reason, `op ${index} (${op.op}): ${failure.detail}`, index);
  }

  const walls = [...draft.walls.values()].sort((a, b) => idNumber(a.id) - idNumber(b.id));
  const openings = [...draft.openings.values()].sort((a, b) => idNumber(a.id) - idNumber(b.id));
  if (role !== "owner") {
    const violation = policyViolation(model, draft);
    if (violation) return reject("forbidden", violation);
  }

  const identity = reconcileSpaces(model, walls);
  let candidate: Model = {
    schemaVersion: 1,
    walls,
    openings,
    spaces: [...identity.spaces],
    next: { ...draft.next, space: identity.nextSpace },
  };
  let derived = derive(candidate);
  if (derived.problems.length > 0) {
    const first = derived.problems[0] as Problem;
    const more = derived.problems.length > 1 ? ` (+${derived.problems.length - 1} more)` : "";
    return {
      ok: false,
      rejection: {
        reason: "invalid_geometry",
        detail: `${first.detail}${more}`,
        problems: derived.problems,
      },
    };
  }

  const effects: Effect[] = [...draft.effects, ...identity.effects];
  if (draft.tags.length > 0) {
    const tagged = applyTags(candidate.spaces, draft.tags, derived, identity.effects);
    if ("reason" in tagged) return { ok: false, rejection: tagged };
    candidate = { ...candidate, spaces: tagged };
    const byId = new Map(tagged.map((r) => [r.id, r]));
    derived = {
      ...derived,
      spaces: derived.spaces.map(({ label: _l, program: _p, ...space }) => ({
        ...space,
        ...tagsOf(byId.get(space.id)),
      })),
    };
  }

  const before = new Map(derive(model).spaces.map((s) => [s.id, s.netArea]));
  for (const space of derived.spaces) {
    const from = before.get(space.id);
    if (from !== undefined && from !== space.netArea) {
      effects.push({ kind: "space_area_changed", space: space.id, from, to: space.netArea });
    }
  }
  return { ok: true, model: candidate, derived, effects };
}

type Draft = {
  walls: Map<WallId, Wall>;
  openings: Map<OpeningId, Opening>;
  next: { wall: number; opening: number; space: number };
  effects: Effect[];
  tags: { index: number; op: TagSpaceOp }[];
  /** Element ID → the op that changed it, for policy messages. */
  cause: Map<string, string>;
};

type Failure = { reason: Rejection["reason"]; detail: string };

function execute(d: Draft, op: Op, index: number): Failure | undefined {
  const label = (id: string) => `op ${index} (${op.op} ${id})`;
  switch (op.op) {
    case "add_wall": {
      const n = claim(d, "wall", op.id);
      if (typeof n !== "number") return n;
      const id: WallId = `W${n}`;
      d.walls.set(id, {
        id,
        start: op.start,
        end: op.end,
        thickness: op.thickness,
        locked: op.locked ?? false,
        structural: op.structural ?? false,
      });
      d.effects.push({ kind: "wall_added", wall: id, op: index });
      d.cause.set(id, label(id));
      return;
    }
    case "remove_wall": {
      const wall = d.walls.get(op.id);
      if (!wall) return notFound(op.id);
      d.walls.delete(op.id);
      d.cause.set(op.id, label(op.id));
      for (const opening of [...d.openings.values()]) {
        if (opening.wall !== op.id) continue;
        d.openings.delete(opening.id);
        d.cause.set(opening.id, label(op.id));
        d.effects.push({ kind: "opening_removed", opening: opening.id, host: op.id, op: index });
      }
      return;
    }
    case "move_wall": {
      const wall = d.walls.get(op.id);
      if (!wall) return notFound(op.id);
      const axis = wallAxis(wall);
      if (!axis) return invalid(`${op.id} is not orthogonal`);
      if (op.by === 0) return;
      const delta: Point = axis === "h" ? { x: 0, y: op.by } : { x: op.by, y: 0 };
      const stretched: Wall[] = [];
      for (const other of d.walls.values()) {
        if (other.id === wall.id) continue;
        for (const end of ["start", "end"] as const) {
          const p = other[end];
          if (!onCentreline(p, wall)) continue;
          if (wallAxis(other) === axis) {
            return invalid(
              `${wall.id} continues in line into ${other.id} at (${p.x}, ${p.y}); moving it would break that joint. Resize or remove ${other.id} in the same batch first`,
            );
          }
          const moved = { ...other, [end]: add(p, delta) };
          const before = wallDirection(other);
          const after = wallDirection(moved);
          if (!wallAxis(moved) || before.x !== after.x || before.y !== after.y) {
            return invalid(`moving ${wall.id} by ${op.by} would collapse or invert ${other.id}`);
          }
          if (end === "start") shiftOpenings(d, other.id, delta.x * before.x + delta.y * before.y);
          stretched.push(moved);
        }
      }
      d.walls.set(wall.id, { ...wall, start: add(wall.start, delta), end: add(wall.end, delta) });
      d.cause.set(wall.id, label(wall.id));
      for (const moved of stretched) {
        d.walls.set(moved.id, moved);
        d.cause.set(moved.id, `${label(wall.id)}, which stretches it`);
        d.effects.push({ kind: "wall_stretched", wall: moved.id, by: wall.id, op: index });
      }
      return;
    }
    case "resize_wall": {
      const wall = d.walls.get(op.id);
      if (!wall) return notFound(op.id);
      const resized = { ...wall, start: op.start, end: op.end };
      const axis = wallAxis(wall);
      const sameLine =
        axis === "h"
          ? op.start.y === wall.start.y && op.end.y === wall.start.y
          : op.start.x === wall.start.x && op.end.x === wall.start.x;
      const before = wallDirection(wall);
      const after = wallDirection(resized);
      if (!sameLine || wallAxis(resized) !== axis || before.x !== after.x || before.y !== after.y) {
        return invalid(
          `resize_wall keeps ${wall.id} on its line and direction; use move_wall to translate it`,
        );
      }
      const shift = (op.start.x - wall.start.x) * before.x + (op.start.y - wall.start.y) * before.y;
      shiftOpenings(d, wall.id, shift);
      d.walls.set(wall.id, resized);
      d.cause.set(wall.id, label(wall.id));
      return;
    }
    case "update_wall": {
      const wall = d.walls.get(op.id);
      if (!wall) return notFound(op.id);
      d.walls.set(wall.id, {
        ...wall,
        ...(op.thickness !== undefined ? { thickness: op.thickness } : {}),
        ...(op.locked !== undefined ? { locked: op.locked } : {}),
        ...(op.structural !== undefined ? { structural: op.structural } : {}),
      });
      d.cause.set(wall.id, label(wall.id));
      return;
    }
    case "add_door":
    case "add_window": {
      if (!d.walls.has(op.wall)) return notFound(op.wall);
      const n = claim(d, "opening", op.id);
      if (typeof n !== "number") return n;
      const id: OpeningId = `O${n}`;
      const placement = {
        id,
        wall: op.wall,
        offset: op.offset,
        width: op.width,
        locked: op.locked ?? false,
      };
      d.openings.set(
        id,
        op.op === "add_door"
          ? {
              ...placement,
              kind: "door",
              hinge: op.hinge ?? "start",
              swing: op.swing ?? "left",
              entrance: op.entrance ?? false,
            }
          : { ...placement, kind: "window" },
      );
      d.effects.push({ kind: "opening_added", opening: id, op: index });
      d.cause.set(id, label(id));
      return;
    }
    case "update_opening": {
      const opening = d.openings.get(op.id);
      if (!opening) return notFound(op.id);
      const common = {
        ...(op.offset !== undefined ? { offset: op.offset } : {}),
        ...(op.width !== undefined ? { width: op.width } : {}),
        ...(op.locked !== undefined ? { locked: op.locked } : {}),
      };
      if (opening.kind === "window") {
        if (op.hinge !== undefined || op.swing !== undefined || op.entrance !== undefined) {
          return invalid(`${op.id} is a window; hinge, swing and entrance apply to doors`);
        }
        d.openings.set(op.id, { ...opening, ...common });
      } else {
        const door: Door = {
          ...opening,
          ...common,
          ...(op.hinge !== undefined ? { hinge: op.hinge } : {}),
          ...(op.swing !== undefined ? { swing: op.swing } : {}),
          ...(op.entrance !== undefined ? { entrance: op.entrance } : {}),
        };
        d.openings.set(op.id, door);
      }
      d.cause.set(op.id, label(op.id));
      return;
    }
    case "remove_opening": {
      if (!d.openings.delete(op.id)) return notFound(op.id);
      d.cause.set(op.id, label(op.id));
      return;
    }
    case "tag_space":
      d.tags.push({ index, op });
      return;
  }
}

/**
 * Non-owner callers may not change protected elements, directly or as an indirect effect: locked or
 * structural walls, openings that are locked or hosted on such walls, and the locked, structural and
 * entrance flags themselves.
 */
function policyViolation(before: Model, d: Draft): string | undefined {
  const why = (id: string) => (d.cause.has(id) ? ` (changed by ${d.cause.get(id)})` : "");
  const oldWalls = new Map(before.walls.map((w) => [w.id, w]));
  const isProtected = (w: Wall | undefined) => !!w && (w.locked || w.structural);
  const kind = (w: Wall) => (w.locked ? "locked" : "structural");
  for (const wall of before.walls) {
    if (isProtected(wall) && !equal(wall, d.walls.get(wall.id))) {
      return `${wall.id} is ${kind(wall)}; only the owner can change it${why(wall.id)}`;
    }
  }
  for (const wall of d.walls.values()) {
    const old = oldWalls.get(wall.id);
    if (isProtected(wall) && !isProtected(old)) {
      return `only the owner can mark walls locked or structural (${wall.id})`;
    }
  }
  const oldOpenings = new Map(before.openings.map((o) => [o.id, o]));
  for (const opening of before.openings) {
    const host = oldWalls.get(opening.wall);
    if ((opening.locked || isProtected(host)) && !equal(opening, d.openings.get(opening.id))) {
      const reason = opening.locked
        ? "is locked"
        : `is in ${kind(host as Wall)} wall ${opening.wall}`;
      return `${opening.id} ${reason}; only the owner can change it${why(opening.id)}`;
    }
    if (opening.kind === "door" && opening.entrance && !d.openings.has(opening.id)) {
      return `only the owner can remove the entrance (${opening.id})${why(opening.id)}`;
    }
  }
  for (const opening of d.openings.values()) {
    const old = oldOpenings.get(opening.id);
    if (equal(opening, old)) continue;
    const host = d.walls.get(opening.wall);
    if (isProtected(host)) {
      return `${opening.wall} is ${kind(host as Wall)}; only the owner can add or change its openings (${opening.id})`;
    }
    if (opening.locked && !old?.locked) return `only the owner can lock openings (${opening.id})`;
    const entrance = opening.kind === "door" && opening.entrance;
    const wasEntrance = old?.kind === "door" && old.entrance;
    if (entrance !== wasEntrance) return `only the owner can set the entrance (${opening.id})`;
  }
  return undefined;
}

function applyTags(
  spaces: readonly SpaceRecord[],
  tags: readonly { index: number; op: TagSpaceOp }[],
  derived: Derived,
  spaceEffects: readonly SpaceEffect[],
): SpaceRecord[] | Rejection {
  const records = new Map(spaces.map((r) => [r.id, r]));
  for (const { index, op } of tags) {
    let id: SpaceId;
    if (typeof op.space === "string") {
      if (!records.has(op.space)) {
        const retired = spaceEffects.find(
          (e) => e.kind === "space_retired" && e.space === op.space,
        );
        const into =
          retired?.kind === "space_retired" && retired.into ? ` into ${retired.into}` : "";
        const detail = retired
          ? `${op.space} was retired${into} by this batch`
          : `no space ${op.space}`;
        return { reason: "not_found", detail: `op ${index} (tag_space): ${detail}`, op: index };
      }
      id = op.space;
    } else {
      const at = spaceAt(derived, op.space);
      if (!at || at === "exterior") {
        const where = at ? "outside every space" : "inside a wall";
        return {
          reason: "invalid_op",
          detail: `op ${index} (tag_space): (${op.space.x}, ${op.space.y}) is ${where}`,
          op: index,
        };
      }
      id = at;
    }
    const { label: oldLabel, program: oldProgram, ...rest } = records.get(id) as SpaceRecord;
    const label = op.label === undefined ? oldLabel : (op.label ?? undefined);
    const program = op.program === undefined ? oldProgram : (op.program ?? undefined);
    records.set(id, { ...rest, ...tagsOf({ label, program }) });
  }
  return [...records.values()];
}

function tagsOf(record: { label?: string | undefined; program?: string | undefined } | undefined) {
  return {
    ...(record?.label !== undefined ? { label: record.label } : {}),
    ...(record?.program !== undefined ? { program: record.program } : {}),
  };
}

/** A fresh ID number. Requested IDs must be above every ID issued so far, so IDs are never reused. */
function claim(d: Draft, kind: "wall" | "opening", requested?: string): number | Failure {
  const prefix = kind === "wall" ? "W" : "O";
  if (requested === undefined) return d.next[kind]++;
  const n = idNumber(requested);
  if (n < d.next[kind]) {
    return invalid(
      `${requested} was already issued; omit id or use ${prefix}${d.next[kind]} or higher`,
    );
  }
  d.next[kind] = n + 1;
  return n;
}

/** Keeps hosted openings in place when the host's start point moves `shift` along the wall. */
function shiftOpenings(d: Draft, wall: WallId, shift: number) {
  if (shift === 0) return;
  for (const opening of d.openings.values()) {
    if (opening.wall === wall)
      d.openings.set(opening.id, { ...opening, offset: opening.offset - shift });
  }
}

function onCentreline(p: Point, wall: Wall): boolean {
  if (wall.start.y === wall.end.y) {
    return (
      p.y === wall.start.y &&
      Math.min(wall.start.x, wall.end.x) <= p.x &&
      p.x <= Math.max(wall.start.x, wall.end.x)
    );
  }
  return (
    p.x === wall.start.x &&
    Math.min(wall.start.y, wall.end.y) <= p.y &&
    p.y <= Math.max(wall.start.y, wall.end.y)
  );
}

function add(p: Point, d: Point): Point {
  return { x: p.x + d.x, y: p.y + d.y };
}

function schemaProblem(op: unknown): string | undefined {
  if (Value.Check(OpSchema, op)) return undefined;
  const name = (op as { op?: unknown } | null)?.op;
  const variant = OpSchema.anyOf.find((s) => s.properties.op.const === name);
  if (!variant) return `unknown op ${JSON.stringify(name)}`;
  const error = Value.Errors(variant, op)[0];
  return error ? `${error.instancePath || "/"} ${error.message}` : "does not match its schema";
}

function notFound(id: string): Failure {
  return { reason: "not_found", detail: `no element ${id}` };
}

function invalid(detail: string): Failure {
  return { reason: "invalid_op", detail };
}

function reject(reason: Rejection["reason"], detail: string, op?: number): ApplyResult {
  return { ok: false, rejection: op === undefined ? { reason, detail } : { reason, detail, op } };
}
