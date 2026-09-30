import {
  type Problem,
  pointAlong,
  type Rect,
  staticProblems,
  type WallGraph,
  wallAxis,
  wallBody,
  wallDirection,
  wallGraph,
} from "./geometry.ts";
import {
  type Barriers,
  barriers,
  cellArea,
  cellAt,
  cellCorner,
  cover,
  type Faces,
  type Grid,
  labelFaces,
  makeGrid,
  narrowArea,
  type Ring,
  traceRings,
} from "./grid.ts";
import type { Model, OpeningId, Point, SpaceId, SpaceRecord, Wall, WallId } from "./model.ts";
import { validateModel } from "./model.ts";

export type SpaceRef = SpaceId | "exterior";

export type DerivedSpace = {
  readonly id: SpaceId;
  readonly label?: string;
  readonly program?: string;
  readonly requirementId?: string;
  readonly anchor: Point;
  /** Area inside the bounding wall centrelines, mm². */
  readonly grossArea: number;
  /** Clear floor area between wall faces, mm². */
  readonly netArea: number;
  /** Centreline outline: counter-clockwise outer rings, clockwise holes. */
  readonly outline: readonly Ring[];
  /** Clear floor outline between wall faces. */
  readonly clear: readonly Ring[];
};

/** Two faces separated by a stretch of one wall. */
export type Adjacency = {
  readonly between: readonly [SpaceRef, SpaceRef];
  readonly wall: WallId;
  readonly length: number;
};

/** The faces on the host's left and right sides (looking from its start to its end). */
export type OpeningSides = {
  readonly id: OpeningId;
  readonly left: SpaceRef;
  readonly right: SpaceRef;
};

/** Raster internals shared with the scorecard. */
export type Raster = {
  readonly grid: Grid;
  readonly faces: Faces;
  /** Cells covered by a wall body. */
  readonly covered: Uint8Array;
  readonly bodies: ReadonlyMap<WallId, Rect>;
  /** Face label per space. */
  readonly faceOf: ReadonlyMap<SpaceId, number>;
};

export type Derived = {
  readonly graph: WallGraph;
  readonly spaces: readonly DerivedSpace[];
  readonly adjacencies: readonly Adjacency[];
  readonly openings: readonly OpeningSides[];
  /** Floor slab: every space plus the walls that bound one. */
  readonly slab: { readonly outline: readonly Ring[]; readonly area: number };
  /** Contract violations: static rules plus those that need faces. Empty for a valid model. */
  readonly problems: readonly Problem[];
  readonly raster: Raster;
};

/** Face geometry of a set of walls on a grid: labels, areas, anchors and wall sides per face. */
export type FaceSet = {
  readonly faces: Faces;
  readonly bars: Barriers;
  /** Gross area per face label. */
  readonly area: readonly number[];
  /** First cell per face in scan order (lowest, then leftmost): the face's canonical key. */
  readonly first: readonly number[];
  /** Per face, `wallId+` or `wallId-` (the face lies on the wall's positive or negative side) → length. */
  readonly sides: readonly ReadonlyMap<string, number>[];
};

export function faceSet(grid: Grid, walls: readonly Wall[]): FaceSet {
  const bars = barriers(grid, walls);
  const faces = labelFaces(grid, bars);
  const area = new Array<number>(faces.count).fill(0);
  const first = new Array<number>(faces.count).fill(-1);
  const sides = Array.from({ length: faces.count }, () => new Map<string, number>());
  const { nx, ny, xs, ys } = grid;
  for (let c = 0; c < nx * ny; c++) {
    const f = faces.label[c] as number;
    area[f] = (area[f] as number) + cellArea(grid, c);
    if (first[f] === -1) first[f] = c;
  }
  const add = (f: number, key: string, length: number) => {
    const map = sides[f] as Map<string, number>;
    map.set(key, (map.get(key) ?? 0) + length);
  };
  for (let i = 1; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const k = bars.v[i * ny + j] as number;
      if (!k) continue;
      const id = (walls[k - 1] as Wall).id;
      const length = (ys[j + 1] as number) - (ys[j] as number);
      add(faces.label[j * nx + i - 1] as number, `${id}-`, length);
      add(faces.label[j * nx + i] as number, `${id}+`, length);
    }
  }
  for (let j = 1; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = bars.h[j * nx + i] as number;
      if (!k) continue;
      const id = (walls[k - 1] as Wall).id;
      const length = (xs[i + 1] as number) - (xs[i] as number);
      add(faces.label[(j - 1) * nx + i] as number, `${id}-`, length);
      add(faces.label[j * nx + i] as number, `${id}+`, length);
    }
  }
  return { faces, bars, area, first, sides };
}

/** A point strictly inside the face, off every wall centreline: one millimetre in from its first corner. */
export function faceAnchor(grid: Grid, set: FaceSet, face: number): Point {
  const corner = cellCorner(grid, set.first[face] as number);
  return { x: corner.x + 1, y: corner.y + 1 };
}

/** Grid lines for a set of walls: centrelines and body edges. */
export function wallCoordinates(
  walls: readonly Wall[],
  graph?: WallGraph,
): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const wall of walls) {
    if (!wallAxis(wall)) continue;
    xs.push(wall.start.x, wall.end.x);
    ys.push(wall.start.y, wall.end.y);
    if (graph) {
      const body = wallBody(wall, graph);
      xs.push(body.x0, body.x1);
      ys.push(body.y0, body.y1);
    }
  }
  return { xs, ys };
}

/** Derives the geometry of a model: junctions, spaces, adjacencies, opening sides, slab and problems. */
export function derive(model: Model): Derived {
  validateModel(model);
  const walls = model.walls.filter((w) => wallAxis(w));
  const graph = wallGraph(walls);
  const coords = wallCoordinates(walls, graph);
  const grid = makeGrid(coords.xs, coords.ys);
  const set = faceSet(grid, walls);
  const { faces } = set;
  const bodies = new Map(walls.map((w) => [w.id, wallBody(w, graph)]));
  const covered = cover(grid, [...bodies.values()]);
  const problems: Problem[] = [...staticProblems(model, graph)];

  const faceOf = new Map<SpaceId, number>();
  const claimed = new Map<number, SpaceRecord>();
  for (const record of model.spaces) {
    // Duplicate IDs are diagnosed by staticProblems; do not overwrite a previous face association.
    if (faceOf.has(record.id)) continue;
    const c = cellAt(grid, record.anchor);
    const f = c >= 0 ? (faces.label[c] as number) : 0;
    const owner = claimed.get(f);
    if (f === 0 || owner) {
      problems.push({
        code: "space_mismatch",
        detail: owner
          ? `${record.id} and ${owner.id} anchor in the same face`
          : `${record.id} is not anchored inside a bounded face`,
        subjects: [record.id],
      });
      continue;
    }
    claimed.set(f, record);
    faceOf.set(record.id, f);
  }
  for (let f = 1; f < faces.count; f++) {
    if (!claimed.has(f)) {
      const at = faceAnchor(grid, set, f);
      problems.push({
        code: "space_mismatch",
        detail: `the face at (${at.x}, ${at.y}) has no space record`,
        subjects: [],
      });
    }
  }

  const n = grid.nx * grid.ny;
  const net = new Array<number>(faces.count).fill(0);
  for (let c = 0; c < n; c++) {
    if (!covered[c]) {
      const f = faces.label[c] as number;
      net[f] = (net[f] as number) + cellArea(grid, c);
    }
  }
  const spaces: DerivedSpace[] = [];
  for (const [f, record] of claimed) {
    spaces.push({
      ...record,
      grossArea: set.area[f] as number,
      netArea: net[f] as number,
      outline: traceRings(grid, (c) => faces.label[c] === f),
      clear: traceRings(grid, (c) => faces.label[c] === f && !covered[c]),
    });
  }

  const ref = (f: number): SpaceRef | undefined => (f === 0 ? "exterior" : claimed.get(f)?.id);
  const adjacencies: Adjacency[] = [];
  for (const [key, length] of pairLengths(grid, set, walls)) {
    const [wall, a, b] = key.split("|") as [WallId, string, string];
    const ra = ref(Number(a));
    const rb = ref(Number(b));
    if (ra && rb && ra !== rb) adjacencies.push({ between: [ra, rb], wall, length });
  }

  const wallById = new Map(walls.map((w) => [w.id, w]));
  const openings: OpeningSides[] = [];
  for (const opening of model.openings) {
    const host = wallById.get(opening.wall);
    if (!host) continue;
    const mid = pointAlong(host, opening.offset + opening.width / 2);
    const d = wallDirection(host);
    const left = { x: mid.x - d.y * 0.5, y: mid.y + d.x * 0.5 };
    const right = { x: mid.x + d.y * 0.5, y: mid.y - d.x * 0.5 };
    const fl = faces.label[cellAt(grid, left)] as number;
    const fr = faces.label[cellAt(grid, right)] as number;
    if (fl === fr) {
      problems.push({
        code: "opening_not_separating",
        detail: `${opening.id} has the same face on both sides of ${host.id}; openings must connect two different spaces or a space and the exterior`,
        subjects: [opening.id, host.id],
      });
      continue;
    }
    const l = ref(fl);
    const r = ref(fr);
    if (l && r) openings.push({ id: opening.id, left: l, right: r });
  }

  const enclosing = new Set<string>();
  set.sides.forEach((sides, f) => {
    if (f === 0) return;
    for (const key of sides.keys()) enclosing.add(key.slice(0, -1));
  });
  const slabCover = cover(
    grid,
    walls.filter((w) => enclosing.has(w.id)).map((w) => bodies.get(w.id) as Rect),
  );
  const inSlab = (c: number) => faces.label[c] !== 0 || slabCover[c] === 1;
  let slabArea = 0;
  for (let c = 0; c < n; c++) if (inSlab(c)) slabArea += cellArea(grid, c);

  return {
    graph,
    spaces: spaces.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
    adjacencies,
    openings,
    slab: { outline: traceRings(grid, inSlab), area: slabArea },
    problems,
    raster: { grid, faces, covered, bodies, faceOf },
  };
}

/** Contract violations of a model. Empty means the model is valid. */
export function checkModel(model: Model): readonly Problem[] {
  return derive(model).problems;
}

/** Area of a space's clear floor that is narrower than `width` (0 if it is at least that wide everywhere). */
export function narrowPart(derived: Derived, space: SpaceId, width: number): number {
  const { grid, faces, covered, faceOf } = derived.raster;
  const f = faceOf.get(space);
  if (f === undefined) return 0;
  return narrowArea(grid, (c) => faces.label[c] === f && !covered[c], width);
}

/** The space or exterior containing a point, or undefined if the point is inside a wall body. */
export function spaceAt(derived: Derived, p: Point): SpaceRef | undefined {
  const { grid, faces, covered, faceOf } = derived.raster;
  const c = cellAt(grid, p);
  if (c < 0) return "exterior";
  if (covered[c]) return undefined;
  const f = faces.label[c] as number;
  if (f === 0) return "exterior";
  for (const [id, face] of faceOf) if (face === f) return id;
  return undefined;
}

function pairLengths(grid: Grid, set: FaceSet, walls: readonly Wall[]): Map<string, number> {
  const { nx, ny, xs, ys } = grid;
  const { bars, faces } = set;
  const lengths = new Map<string, number>();
  const add = (k: number, a: number, b: number, length: number) => {
    const key = `${(walls[k - 1] as Wall).id}|${a}|${b}`;
    lengths.set(key, (lengths.get(key) ?? 0) + length);
  };
  for (let i = 1; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const k = bars.v[i * ny + j] as number;
      if (k)
        add(
          k,
          faces.label[j * nx + i - 1] as number,
          faces.label[j * nx + i] as number,
          (ys[j + 1] as number) - (ys[j] as number),
        );
    }
  }
  for (let j = 1; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = bars.h[j * nx + i] as number;
      if (k)
        add(
          k,
          faces.label[(j - 1) * nx + i] as number,
          faces.label[j * nx + i] as number,
          (xs[i + 1] as number) - (xs[i] as number),
        );
    }
  }
  return lengths;
}
