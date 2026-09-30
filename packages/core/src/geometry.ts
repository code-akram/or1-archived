import { GEOMETRY } from "./contract.ts";
import type { Model, Opening, Point, Wall, WallId } from "./model.ts";

/** A rule violation. `subjects` lists the element IDs involved, for highlighting and agent feedback. */
export type Problem = {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly subjects: readonly string[];
};

export type ProblemCode =
  | "duplicate_id"
  | "bad_thickness"
  | "not_orthogonal"
  | "zero_length"
  | "overlap"
  | "short_segment"
  | "too_close"
  | "unknown_host"
  | "opening_too_narrow"
  | "opening_off_segment"
  | "opening_overlap"
  | "opening_not_separating"
  | "space_mismatch";

export type Axis = "h" | "v";

/** Rectangle `[x0, x1] × [y0, y1]`. */
export type Rect = {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
};

export type JunctionKind = "end" | "joint" | "L" | "T" | "X";

/** A point where walls meet or a wall ends. `joint` is a collinear join of two walls. */
export type Junction = {
  readonly at: Point;
  readonly kind: JunctionKind;
  readonly walls: readonly WallId[];
};

/** A point along a wall where the wall graph has a node, measured from the wall's start. */
export type Station = {
  readonly at: number;
  /** Half the thickness of the thickest perpendicular wall meeting here; openings keep this clear. */
  readonly clearance: number;
};

/** The piece of a wall between two consecutive stations: one edge of the wall graph. */
export type Segment = {
  readonly wall: Wall;
  readonly from: Point;
  readonly to: Point;
};

export type WallGraph = {
  readonly junctions: readonly Junction[];
  /** Stations per wall ID, sorted by distance from the wall's start. */
  readonly stations: ReadonlyMap<WallId, readonly Station[]>;
  readonly segments: readonly Segment[];
  /** Problems found while building the graph: overlapping collinear walls. */
  readonly problems: readonly Problem[];
};

export function wallAxis(wall: Wall): Axis | undefined {
  const h = wall.start.y === wall.end.y;
  const v = wall.start.x === wall.end.x;
  if (h === v) return undefined;
  return h ? "h" : "v";
}

export function wallLength(wall: Wall): number {
  return Math.abs(wall.end.x - wall.start.x) + Math.abs(wall.end.y - wall.start.y);
}

/** Unit direction from start to end, for an orthogonal wall. */
export function wallDirection(wall: Wall): Point {
  return {
    x: Math.sign(wall.end.x - wall.start.x),
    y: Math.sign(wall.end.y - wall.start.y),
  };
}

/** The point at distance `at` along the wall from its start. */
export function pointAlong(wall: Wall, at: number): Point {
  const d = wallDirection(wall);
  return { x: wall.start.x + d.x * at, y: wall.start.y + d.y * at };
}

/** Problems with one wall on its own. */
export function wallProblems(wall: Wall): Problem[] {
  const problems: Problem[] = [];
  const { minThickness, maxThickness } = GEOMETRY;
  if (wall.thickness < minThickness || wall.thickness > maxThickness || wall.thickness % 2 !== 0) {
    problems.push({
      code: "bad_thickness",
      detail: `${wall.id}: thickness ${wall.thickness} must be an even number from ${minThickness} to ${maxThickness}`,
      subjects: [wall.id],
    });
  }
  if (wall.start.x === wall.end.x && wall.start.y === wall.end.y) {
    problems.push({
      code: "zero_length",
      detail: `${wall.id} has zero length`,
      subjects: [wall.id],
    });
  } else if (!wallAxis(wall)) {
    problems.push({
      code: "not_orthogonal",
      detail: `${wall.id} is not horizontal or vertical`,
      subjects: [wall.id],
    });
  }
  return problems;
}

/**
 * Builds the wall graph: nodes where walls meet (L, T, X, collinear joints) or end, and the segments
 * between them. Only orthogonal, non-degenerate walls take part.
 */
export function wallGraph(walls: readonly Wall[]): WallGraph {
  const usable = walls.filter((w) => wallAxis(w));
  const problems: Problem[] = [];
  const positions = new Map<WallId, Set<number>>(
    usable.map((w) => [w.id, new Set([0, wallLength(w)])]),
  );
  const addStation = (wall: Wall, p: Point) =>
    positions.get(wall.id)?.add(Math.abs(p.x - wall.start.x) + Math.abs(p.y - wall.start.y));

  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i] as Wall;
      const b = usable[j] as Wall;
      const contact = wallContact(a, b);
      if (contact === "overlap") {
        problems.push({
          code: "overlap",
          detail: `${a.id} and ${b.id} overlap along the same line`,
          subjects: [a.id, b.id],
        });
      } else if (contact) {
        addStation(a, contact);
        addStation(b, contact);
      }
    }
  }

  const nodes = new Map<string, { at: Point; dirs: Set<number>; walls: Wall[] }>();
  const stationPoints = new Map<WallId, { at: number; point: Point }[]>();
  for (const wall of usable) {
    const length = wallLength(wall);
    const sorted = [...(positions.get(wall.id) ?? [])].sort((p, q) => p - q);
    const d = wallDirection(wall);
    const forward = dirIndex(d);
    const points = sorted.map((at) => ({ at, point: pointAlong(wall, at) }));
    stationPoints.set(wall.id, points);
    for (const { at, point } of points) {
      const key = `${point.x},${point.y}`;
      let node = nodes.get(key);
      if (!node) {
        node = { at: point, dirs: new Set(), walls: [] };
        nodes.set(key, node);
      }
      if (at > 0) node.dirs.add((forward + 2) % 4);
      if (at < length) node.dirs.add(forward);
      node.walls.push(wall);
    }
  }

  const stations = new Map<WallId, Station[]>();
  const segments: Segment[] = [];
  for (const wall of usable) {
    const axis = wallAxis(wall);
    const points = stationPoints.get(wall.id) ?? [];
    stations.set(
      wall.id,
      points.map(({ at, point }) => {
        const node = nodes.get(`${point.x},${point.y}`);
        const across = (node?.walls ?? []).filter((w) => w !== wall && wallAxis(w) !== axis);
        return { at, clearance: Math.max(0, ...across.map((w) => w.thickness / 2)) };
      }),
    );
    for (let k = 1; k < points.length; k++) {
      segments.push({
        wall,
        from: (points[k - 1] as { point: Point }).point,
        to: (points[k] as { point: Point }).point,
      });
    }
  }

  const junctions = [...nodes.values()]
    .map((node) => ({
      at: node.at,
      kind: junctionKind(node.dirs),
      walls: [...new Set(node.walls.map((w) => w.id))],
    }))
    .sort((p, q) => p.at.y - q.at.y || p.at.x - q.at.x);

  return { junctions, stations, segments, problems };
}

/**
 * Checks the walls and openings against the contract's static rules: shape, tolerances, junctions and
 * opening hosting. Rules that need derived faces live in derive.ts.
 */
export function staticProblems(model: Model, graph: WallGraph): Problem[] {
  const problems: Problem[] = [];
  problems.push(
    ...duplicateIds(model.walls),
    ...duplicateIds(model.openings),
    ...duplicateIds(model.spaces),
  );
  for (const wall of model.walls) problems.push(...wallProblems(wall));
  problems.push(...graph.problems);

  for (const segment of graph.segments) {
    const length =
      Math.abs(segment.to.x - segment.from.x) + Math.abs(segment.to.y - segment.from.y);
    if (length < GEOMETRY.minSegment) {
      problems.push({
        code: "short_segment",
        detail: `${segment.wall.id} has a ${length} mm segment at (${segment.from.x}, ${segment.from.y}); segments between junctions must be at least ${GEOMETRY.minSegment} mm`,
        subjects: [segment.wall.id],
      });
    }
  }
  problems.push(...clearanceProblems(model.walls, graph));
  problems.push(...openingProblems(model, graph));
  return problems;
}

/** The body of a wall: its centreline widened by the thickness, extended into perpendicular walls it joins. */
export function wallBody(wall: Wall, graph: WallGraph): Rect {
  const stations = graph.stations.get(wall.id) ?? [];
  const startExt = stations[0]?.at === 0 ? stations[0].clearance : 0;
  const last = stations[stations.length - 1];
  const endExt = last?.at === wallLength(wall) ? last.clearance : 0;
  const d = wallDirection(wall);
  const half = wall.thickness / 2;
  const x0 = wall.start.x - d.x * startExt;
  const y0 = wall.start.y - d.y * startExt;
  const x1 = wall.end.x + d.x * endExt;
  const y1 = wall.end.y + d.y * endExt;
  const h = wallAxis(wall) === "h";
  return {
    x0: Math.min(x0, x1) - (h ? 0 : half),
    x1: Math.max(x0, x1) + (h ? 0 : half),
    y0: Math.min(y0, y1) - (h ? half : 0),
    y1: Math.max(y0, y1) + (h ? half : 0),
  };
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
}

export function rectOverlap(a: Rect, b: Rect): number {
  return rectArea({
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  });
}

/** How two walls touch: a shared point, an overlap along one line, or nothing. */
function wallContact(a: Wall, b: Wall): Point | "overlap" | undefined {
  const ra = bounds(a);
  const rb = bounds(b);
  const axA = wallAxis(a);
  if (axA !== wallAxis(b)) {
    const h = axA === "h" ? ra : rb;
    const v = axA === "h" ? rb : ra;
    const x = v.x0;
    const y = h.y0;
    if (h.x0 <= x && x <= h.x1 && v.y0 <= y && y <= v.y1) return { x, y };
    return undefined;
  }
  const sameLine = axA === "h" ? ra.y0 === rb.y0 : ra.x0 === rb.x0;
  if (!sameLine) return undefined;
  const [lo0, hi0, lo1, hi1] =
    axA === "h" ? [ra.x0, ra.x1, rb.x0, rb.x1] : [ra.y0, ra.y1, rb.y0, rb.y1];
  const lo = Math.max(lo0, lo1);
  const hi = Math.min(hi0, hi1);
  if (lo < hi) return "overlap";
  if (lo === hi) return axA === "h" ? { x: lo, y: ra.y0 } : { x: ra.x0, y: lo };
  return undefined;
}

/**
 * Walls that are not joined must keep `minGap` clear between their bodies. Segments sharing a node are
 * joined; collinear segments with only walls between them are one run of wall.
 */
function clearanceProblems(walls: readonly Wall[], graph: WallGraph): Problem[] {
  const { segments } = graph;
  const problems: Problem[] = [];
  const reported = new Set<string>();
  const minGap2 = GEOMETRY.minGap ** 2;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i] as Segment;
      const b = segments[j] as Segment;
      if (a.wall === b.wall || sharesNode(a, b)) continue;
      if (collinearRun(a, b, walls)) continue;
      const ra = segmentBody(a, graph);
      const rb = segmentBody(b, graph);
      const dx = Math.max(0, ra.x0 - rb.x1, rb.x0 - ra.x1);
      const dy = Math.max(0, ra.y0 - rb.y1, rb.y0 - ra.y1);
      if (dx * dx + dy * dy >= minGap2) continue;
      const key = [a.wall.id, b.wall.id].sort().join(" ");
      if (reported.has(key)) continue;
      reported.add(key);
      const clear = Math.floor(Math.sqrt(dx * dx + dy * dy));
      problems.push({
        code: "too_close",
        detail:
          clear === 0
            ? `${a.wall.id} and ${b.wall.id} collide without meeting at a junction; walls join only where their centrelines meet`
            : `${a.wall.id} and ${b.wall.id} leave only ${clear} mm clear; unjoined walls need at least ${GEOMETRY.minGap} mm`,
        subjects: [a.wall.id, b.wall.id],
      });
    }
  }
  return problems;
}

function openingProblems(model: Model, graph: WallGraph): Problem[] {
  const problems: Problem[] = [];
  const walls = new Map(model.walls.map((w) => [w.id, w]));
  const byHost = new Map<WallId, Opening[]>();
  for (const opening of model.openings) {
    const host = walls.get(opening.wall);
    if (!host) {
      problems.push({
        code: "unknown_host",
        detail: `${opening.id} is hosted on missing wall ${opening.wall}`,
        subjects: [opening.id],
      });
      continue;
    }
    if (opening.width < GEOMETRY.minSegment) {
      problems.push({
        code: "opening_too_narrow",
        detail: `${opening.id} is ${opening.width} mm wide; openings must be at least ${GEOMETRY.minSegment} mm`,
        subjects: [opening.id],
      });
    }
    const stations = graph.stations.get(host.id);
    if (stations && !fitsSegment(opening, stations)) {
      problems.push({
        code: "opening_off_segment",
        detail: `${opening.id} (offset ${opening.offset}, width ${opening.width}) must lie within one segment of ${host.id}, clear of junctions by half the meeting wall's thickness`,
        subjects: [opening.id, host.id],
      });
    }
    byHost.set(host.id, [...(byHost.get(host.id) ?? []), opening]);
  }
  for (const list of byHost.values()) {
    const sorted = [...list].sort((a, b) => a.offset - b.offset);
    for (let k = 1; k < sorted.length; k++) {
      const prev = sorted[k - 1] as Opening;
      const next = sorted[k] as Opening;
      if (prev.offset + prev.width > next.offset) {
        problems.push({
          code: "opening_overlap",
          detail: `${prev.id} and ${next.id} overlap on ${next.wall}`,
          subjects: [prev.id, next.id],
        });
      }
    }
  }
  return problems;
}

function fitsSegment(opening: Opening, stations: readonly Station[]): boolean {
  const lo = opening.offset;
  const hi = opening.offset + opening.width;
  for (let k = 1; k < stations.length; k++) {
    const a = stations[k - 1] as Station;
    const b = stations[k] as Station;
    if (lo >= a.at + a.clearance && hi <= b.at - b.clearance) return true;
  }
  return false;
}

function duplicateIds(items: readonly { id: string }[]): Problem[] {
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const { id } of items) {
    if (seen.has(id)) {
      problems.push({ code: "duplicate_id", detail: `${id} is used twice`, subjects: [id] });
    }
    seen.add(id);
  }
  return problems;
}

function bounds(wall: Wall): Rect {
  return {
    x0: Math.min(wall.start.x, wall.end.x),
    x1: Math.max(wall.start.x, wall.end.x),
    y0: Math.min(wall.start.y, wall.end.y),
    y1: Math.max(wall.start.y, wall.end.y),
  };
}

/** The wall footprint clipped at internal graph stations, retaining extensions at actual endpoints. */
function segmentBody(s: Segment, graph: WallGraph): Rect {
  const body = wallBody(s.wall, graph);
  const whole = bounds(s.wall);
  const piece = bounds({ ...s.wall, start: s.from, end: s.to });
  const h = s.from.y === s.to.y;
  return h
    ? {
        ...body,
        x0: piece.x0 === whole.x0 ? body.x0 : piece.x0,
        x1: piece.x1 === whole.x1 ? body.x1 : piece.x1,
      }
    : {
        ...body,
        y0: piece.y0 === whole.y0 ? body.y0 : piece.y0,
        y1: piece.y1 === whole.y1 ? body.y1 : piece.y1,
      };
}

function sharesNode(a: Segment, b: Segment): boolean {
  const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y;
  return same(a.from, b.from) || same(a.from, b.to) || same(a.to, b.from) || same(a.to, b.to);
}

/** True if a and b lie on one line and walls on that line cover the whole gap between them. */
function collinearRun(a: Segment, b: Segment, walls: readonly Wall[]): boolean {
  const h = a.from.y === a.to.y;
  if (h !== (b.from.y === b.to.y)) return false;
  const line = h ? a.from.y : a.from.x;
  if (line !== (h ? b.from.y : b.from.x)) return false;
  const span = (s: Segment) =>
    h
      ? [Math.min(s.from.x, s.to.x), Math.max(s.from.x, s.to.x)]
      : [Math.min(s.from.y, s.to.y), Math.max(s.from.y, s.to.y)];
  const [a0, a1] = span(a) as [number, number];
  const [b0, b1] = span(b) as [number, number];
  let lo = Math.min(a1, b1);
  const hi = Math.max(a0, b0);
  const cover = walls
    .filter((w) => wallAxis(w) === (h ? "h" : "v") && (h ? w.start.y : w.start.x) === line)
    .map((w) => bounds(w))
    .map((r) => (h ? [r.x0, r.x1] : [r.y0, r.y1]) as [number, number])
    .sort((p, q) => p[0] - q[0]);
  for (const [c0, c1] of cover) {
    if (c0 <= lo && c1 > lo) lo = c1;
  }
  return lo >= hi;
}

/** Direction index: 0 = +x, 1 = +y, 2 = −x, 3 = −y. */
function dirIndex(d: Point): number {
  if (d.x > 0) return 0;
  if (d.y > 0) return 1;
  if (d.x < 0) return 2;
  return 3;
}

function junctionKind(dirs: ReadonlySet<number>): JunctionKind {
  switch (dirs.size) {
    case 1:
      return "end";
    case 2: {
      const [a, b] = [...dirs] as [number, number];
      return (a + 2) % 4 === b ? "joint" : "L";
    }
    case 3:
      return "T";
    default:
      return "X";
  }
}
