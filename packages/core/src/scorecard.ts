import {
  type Brief,
  type Constraint,
  DEFAULT_CIRCULATION,
  DEFAULT_THRESHOLDS,
  DEFAULT_UNREACHABLE,
} from "./brief.ts";
import { type Derived, type DerivedSpace, derive, narrowPart, type SpaceRef } from "./derive.ts";
import { equal } from "./equal.ts";
import { pointAlong, type Rect, rectOverlap, wallDirection } from "./geometry.ts";
import type { Model, SpaceId, Wall } from "./model.ts";

/** Hard gates, in evaluation order. An option is valid only if every gate passes. */
export const GATES = [
  "topology",
  "protected_intact",
  "required_rooms",
  "reachable",
  "corridor_width",
  "door_width",
  "door_clearance",
  "hard_constraints",
] as const;
export type GateName = (typeof GATES)[number];

export type Finding = { readonly detail: string; readonly subjects: readonly string[] };

export type GateResult = {
  readonly gate: GateName;
  readonly passed: boolean;
  readonly failures: readonly Finding[];
};

/** The outcome of one brief constraint, hard or soft. `index` is its position in `brief.constraints`. */
export type ConstraintResult = {
  readonly index: number;
  readonly kind: Constraint["kind"];
  readonly hard: boolean;
  readonly met: boolean;
  readonly failures: readonly Finding[];
};

export type ScoreName = "area_fit" | "soft_rooms" | "soft_constraints" | "daylight";

/** A soft score in [0, 1], higher is better. Only scores the brief gives inputs for are reported. */
export type ScoreResult = {
  readonly score: ScoreName;
  readonly value: number;
  readonly detail: string;
};

export type Scorecard = {
  readonly valid: boolean;
  readonly gates: readonly GateResult[];
  readonly constraints: readonly ConstraintResult[];
  readonly scores: readonly ScoreResult[];
};

/**
 * Pure scorecard shared by agents, the UI and evals. `base` is the model the option forked from; its
 * locked and structural elements must be intact. Establishes validity and consistency, not quality.
 */
export function scorecard(model: Model, brief: Brief, base: Model): Scorecard {
  const derived = derive(model);
  const ctx = context(model, brief, derived);
  const constraints = brief.constraints.map((c, index) => evaluate(c, index, ctx));

  const gates: GateResult[] = [
    gate(
      "topology",
      derived.problems.map((p) => ({ detail: p.detail, subjects: p.subjects })),
    ),
    gate("protected_intact", protectedFailures(model, base)),
    gate("required_rooms", roomFailures(brief, ctx, true)),
    gate("reachable", reachFailures(ctx)),
    gate("corridor_width", corridorFailures(ctx)),
    gate("door_width", doorWidthFailures(ctx)),
    gate("door_clearance", doorClearanceFailures(ctx)),
    gate(
      "hard_constraints",
      constraints.filter((c) => c.hard && !c.met).flatMap((c) => c.failures),
    ),
  ];

  const scores: ScoreResult[] = [];
  const targets = brief.rooms.filter((r) => r.targetAreaM2 !== undefined);
  if (targets.length > 0) scores.push(areaFit(targets, ctx));
  const softRooms = brief.rooms.filter((r) => !r.hard);
  if (softRooms.length > 0) {
    const missing = roomFailures(brief, ctx, false);
    scores.push({
      score: "soft_rooms",
      value: (softRooms.length - missing.length) / softRooms.length,
      detail: `${softRooms.length - missing.length} of ${softRooms.length} soft rooms present`,
    });
  }
  const soft = constraints.filter((c) => !c.hard);
  if (soft.length > 0) {
    const met = soft.filter((c) => c.met).length;
    scores.push({
      score: "soft_constraints",
      value: met / soft.length,
      detail: `${met} of ${soft.length} soft constraints met`,
    });
  }
  const habitable = new Set(brief.rooms.filter((r) => r.habitable).map((r) => r.program));
  const habitableSpaces = derived.spaces.filter((s) => s.program && habitable.has(s.program));
  if (habitable.size > 0) {
    const lit = habitableSpaces.filter((s) => ctx.daylit.has(s.id)).length;
    scores.push({
      score: "daylight",
      value: habitableSpaces.length === 0 ? 0 : lit / habitableSpaces.length,
      detail: `${lit} of ${habitableSpaces.length} habitable spaces have a window to the exterior`,
    });
  }

  return { valid: gates.every((g) => g.passed), gates, constraints, scores };
}

type Context = {
  readonly model: Model;
  readonly derived: Derived;
  readonly byProgram: ReadonlyMap<string, readonly DerivedSpace[]>;
  readonly walls: ReadonlyMap<string, Wall>;
  readonly daylit: ReadonlySet<SpaceId>;
  readonly thresholds: { corridorWidth: number; doorWidth: number; entranceDoorWidth: number };
  readonly circulation: ReadonlySet<string>;
  readonly unreachable: ReadonlySet<string>;
};

function context(model: Model, brief: Brief, derived: Derived): Context {
  const byProgram = new Map<string, DerivedSpace[]>();
  for (const space of derived.spaces) {
    if (space.program)
      byProgram.set(space.program, [...(byProgram.get(space.program) ?? []), space]);
  }
  const windows = new Set(model.openings.filter((o) => o.kind === "window").map((o) => o.id));
  const daylit = new Set<SpaceId>();
  for (const sides of derived.openings) {
    if (!windows.has(sides.id)) continue;
    if (sides.left === "exterior" && sides.right !== "exterior") daylit.add(sides.right);
    if (sides.right === "exterior" && sides.left !== "exterior") daylit.add(sides.left);
  }
  return {
    model,
    derived,
    byProgram,
    walls: new Map(model.walls.map((w) => [w.id, w])),
    daylit,
    thresholds: { ...DEFAULT_THRESHOLDS, ...brief.thresholds },
    circulation: new Set(brief.circulation ?? DEFAULT_CIRCULATION),
    unreachable: new Set(brief.unreachable ?? DEFAULT_UNREACHABLE),
  };
}

function gate(name: GateName, failures: readonly Finding[]): GateResult {
  return { gate: name, passed: failures.length === 0, failures };
}

function protectedFailures(model: Model, base: Model): Finding[] {
  const failures: Finding[] = [];
  const walls = new Map(model.walls.map((w) => [w.id, w]));
  const openings = new Map(model.openings.map((o) => [o.id, o]));
  const baseWalls = new Map(base.walls.map((w) => [w.id, w]));
  for (const wall of base.walls) {
    if ((wall.locked || wall.structural) && !equal(wall, walls.get(wall.id))) {
      const kind = wall.locked ? "locked" : "structural";
      failures.push({
        detail: `${kind} wall ${wall.id} was changed or removed`,
        subjects: [wall.id],
      });
    }
  }
  for (const opening of base.openings) {
    const host = baseWalls.get(opening.wall);
    const guarded = opening.locked || !!host?.locked || !!host?.structural;
    if (guarded && !equal(opening, openings.get(opening.id))) {
      failures.push({
        detail: `protected opening ${opening.id} was changed or removed`,
        subjects: [opening.id],
      });
    }
  }
  for (const opening of model.openings) {
    const host = baseWalls.get(opening.wall);
    if ((host?.locked || host?.structural) && !base.openings.some((o) => o.id === opening.id)) {
      failures.push({
        detail: `opening ${opening.id} was added to protected wall ${opening.wall}`,
        subjects: [opening.id, opening.wall],
      });
    }
  }
  return failures;
}

function roomFailures(brief: Brief, ctx: Context, hard: boolean): Finding[] {
  const failures: Finding[] = [];
  for (const room of brief.rooms) {
    if (room.hard !== hard) continue;
    const want = room.count ?? 1;
    const have = ctx.byProgram.get(room.program)?.length ?? 0;
    if (have < want) {
      failures.push({ detail: `${room.program}: ${have} of ${want} present`, subjects: [] });
    }
  }
  return failures;
}

function reachFailures(ctx: Context): Finding[] {
  const doors = new Map(ctx.model.openings.filter((o) => o.kind === "door").map((o) => [o.id, o]));
  const entrances = ctx.derived.openings.filter((s) => {
    const door = doors.get(s.id);
    return (
      door?.kind === "door" && door.entrance && (s.left === "exterior" || s.right === "exterior")
    );
  });
  if (entrances.length === 0) {
    return [{ detail: "the model has no entrance door to the exterior", subjects: [] }];
  }
  const links = new Map<SpaceRef, SpaceRef[]>();
  const link = (a: SpaceRef, b: SpaceRef) => links.set(a, [...(links.get(a) ?? []), b]);
  for (const sides of ctx.derived.openings) {
    if (!doors.has(sides.id) || sides.left === "exterior" || sides.right === "exterior") continue;
    link(sides.left, sides.right);
    link(sides.right, sides.left);
  }
  const reached = new Set<SpaceRef>();
  const queue: SpaceRef[] = entrances
    .flatMap((s) => [s.left, s.right])
    .filter((r) => r !== "exterior");
  for (const r of queue) reached.add(r);
  while (queue.length > 0) {
    const r = queue.shift() as SpaceRef;
    for (const next of links.get(r) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return ctx.derived.spaces
    .filter((s) => !reached.has(s.id) && !(s.program && ctx.unreachable.has(s.program)))
    .map((s) => ({
      detail: `${s.id}${s.program ? ` (${s.program})` : ""} is not reachable from the entrance through doors`,
      subjects: [s.id],
    }));
}

function corridorFailures(ctx: Context): Finding[] {
  const width = ctx.thresholds.corridorWidth;
  return ctx.derived.spaces
    .filter((s) => s.program && ctx.circulation.has(s.program))
    .flatMap((s) => {
      const narrow = narrowPart(ctx.derived, s.id, width);
      return narrow === 0
        ? []
        : [
            {
              detail: `${s.id} (${s.program}) has ${m2(narrow)} m² narrower than ${width} mm`,
              subjects: [s.id],
            },
          ];
    });
}

function doorWidthFailures(ctx: Context): Finding[] {
  const failures: Finding[] = [];
  for (const door of ctx.model.openings) {
    if (door.kind !== "door") continue;
    const min = door.entrance ? ctx.thresholds.entranceDoorWidth : ctx.thresholds.doorWidth;
    if (door.width < min) {
      failures.push({
        detail: `${door.entrance ? "entrance door" : "door"} ${door.id} is ${door.width} mm wide; minimum ${min} mm`,
        subjects: [door.id],
      });
    }
  }
  return failures;
}

/** The leaf's swing (a square of the door's width on its swing side) must not hit another wall. */
function doorClearanceFailures(ctx: Context): Finding[] {
  const failures: Finding[] = [];
  for (const door of ctx.model.openings) {
    if (door.kind !== "door") continue;
    const host = ctx.walls.get(door.wall);
    if (!host) continue;
    const d = wallDirection(host);
    const sign = door.swing === "left" ? 1 : -1;
    const normal = { x: -d.y * sign, y: d.x * sign };
    const half = host.thickness / 2;
    const a = pointAlong(host, door.offset);
    const b = pointAlong(host, door.offset + door.width);
    const p = { x: a.x + normal.x * half, y: a.y + normal.y * half };
    const q = { x: b.x + normal.x * (half + door.width), y: b.y + normal.y * (half + door.width) };
    const sweep: Rect = {
      x0: Math.min(p.x, q.x),
      x1: Math.max(p.x, q.x),
      y0: Math.min(p.y, q.y),
      y1: Math.max(p.y, q.y),
    };
    const hits = [...ctx.derived.raster.bodies]
      .filter(([id, body]) => id !== host.id && rectOverlap(sweep, body) > 0)
      .map(([id]) => id);
    if (hits.length > 0) {
      failures.push({
        detail: `door ${door.id} swings into ${hits.join(", ")}`,
        subjects: [door.id, ...hits],
      });
    }
  }
  return failures;
}

function evaluate(c: Constraint, index: number, ctx: Context): ConstraintResult {
  const failures = constraintFailures(c, ctx);
  return { index, kind: c.kind, hard: c.hard, met: failures.length === 0, failures };
}

function constraintFailures(c: Constraint, ctx: Context): Finding[] {
  const label = `constraint ${c.kind}`;
  const spacesOf = (program: string) => ctx.byProgram.get(program) ?? [];
  const none = (program: string): Finding[] => [
    { detail: `${label}: no space is tagged ${program}`, subjects: [] },
  ];
  const each = (program: string, fails: (s: DerivedSpace) => string | undefined): Finding[] => {
    const spaces = spacesOf(program);
    if (spaces.length === 0) return none(program);
    return spaces.flatMap((s) => {
      const why = fails(s);
      return why ? [{ detail: `${label}: ${s.id} (${program}) ${why}`, subjects: [s.id] }] : [];
    });
  };
  switch (c.kind) {
    case "min_area":
      return each(c.program, (s) =>
        s.netArea / 1e6 < c.areaM2 ? `has ${m2(s.netArea)} m², needs ≥ ${c.areaM2} m²` : undefined,
      );
    case "max_area":
      return each(c.program, (s) =>
        s.netArea / 1e6 > c.areaM2 ? `has ${m2(s.netArea)} m², allows ≤ ${c.areaM2} m²` : undefined,
      );
    case "min_width":
      return each(c.program, (s) => {
        const narrow = narrowPart(ctx.derived, s.id, c.width);
        return narrow > 0 ? `has ${m2(narrow)} m² narrower than ${c.width} mm` : undefined;
      });
    case "daylight":
      return each(c.program, (s) =>
        ctx.daylit.has(s.id) ? undefined : "has no window to the exterior",
      );
    case "adjacent": {
      const targets = new Set<SpaceRef>(spacesOf(c.b).map((s) => s.id));
      if (targets.size === 0) return none(c.b);
      const doors = new Set(ctx.model.openings.filter((o) => o.kind === "door").map((o) => o.id));
      const pairs =
        c.via === "door"
          ? ctx.derived.openings
              .filter((o) => doors.has(o.id))
              .map((o) => [o.left, o.right] as const)
          : ctx.derived.adjacencies.map((a) => a.between);
      return each(c.a, (s) => {
        const touches = pairs.some(
          ([x, y]) =>
            (x === s.id && targets.has(y) && y !== s.id) ||
            (y === s.id && targets.has(x) && x !== s.id),
        );
        return touches ? undefined : `does not share a ${c.via} with a ${c.b}`;
      });
    }
  }
}

/**
 * 1 − mean relative deviation from target clear area, per required instance; each deviation is capped
 * at 1 and a missing instance counts as 1. Surplus spaces are ignored; the closest ones are matched.
 */
function areaFit(rooms: Brief["rooms"], ctx: Context): ScoreResult {
  const deviations: number[] = [];
  for (const room of rooms) {
    const target = room.targetAreaM2 as number;
    const devs = (ctx.byProgram.get(room.program) ?? [])
      .map((s) => Math.min(1, Math.abs(s.netArea / 1e6 - target) / target))
      .sort((a, b) => a - b);
    for (let k = 0; k < (room.count ?? 1); k++) deviations.push(devs[k] ?? 1);
  }
  const mean = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  return {
    score: "area_fit",
    value: 1 - mean,
    detail: `mean deviation from target area ${(mean * 100).toFixed(1)}% over ${deviations.length} rooms`,
  };
}

function m2(mm2: number): string {
  return (mm2 / 1e6).toFixed(2);
}
