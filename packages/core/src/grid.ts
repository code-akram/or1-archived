import { wallAxis } from "./geometry.ts";
import type { Point, Wall } from "./model.ts";

/**
 * A compressed grid over the plan. Every wall centreline and body edge lies on a grid line, so each cell
 * is wholly inside or outside every face and every wall body. Areas summed over cells are exact.
 * Cell `c = j * nx + i` spans `[xs[i], xs[i+1]] × [ys[j], ys[j+1]]`.
 */
export type Grid = {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly nx: number;
  readonly ny: number;
};

export type Ring = readonly Point[];

/** Builds a grid over the given coordinates, padded so the border cells are always exterior. */
export function makeGrid(xs: Iterable<number>, ys: Iterable<number>): Grid {
  const pad = (values: Iterable<number>) => {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    if (sorted.length === 0) return [];
    return [(sorted[0] as number) - 1000, ...sorted, (sorted[sorted.length - 1] as number) + 1000];
  };
  const gx = pad(xs);
  const gy = pad(ys);
  return { xs: gx, ys: gy, nx: Math.max(0, gx.length - 1), ny: Math.max(0, gy.length - 1) };
}

export function cellArea(grid: Grid, c: number): number {
  const i = c % grid.nx;
  const j = (c - i) / grid.nx;
  return (
    ((grid.xs[i + 1] as number) - (grid.xs[i] as number)) *
    ((grid.ys[j + 1] as number) - (grid.ys[j] as number))
  );
}

/** Cell containing the point, using half-open intervals; −1 outside the grid. */
export function cellAt(grid: Grid, p: { x: number; y: number }): number {
  const i = lowerIndex(grid.xs, p.x);
  const j = lowerIndex(grid.ys, p.y);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) return -1;
  return j * grid.nx + i;
}

/** The bottom-left corner of a cell. */
export function cellCorner(grid: Grid, c: number): Point {
  const i = c % grid.nx;
  const j = (c - i) / grid.nx;
  return { x: grid.xs[i] as number, y: grid.ys[j] as number };
}

/**
 * Wall centrelines as barriers between cells. `v[i * ny + j]` is the barrier on the vertical line `xs[i]`
 * across row j; `h[j * nx + i]` on the horizontal line `ys[j]` across column i. Values are wall index + 1.
 */
export type Barriers = { readonly v: Int32Array; readonly h: Int32Array };

export function barriers(grid: Grid, walls: readonly Wall[]): Barriers {
  const { nx, ny } = grid;
  const v = new Int32Array((nx + 1) * ny);
  const h = new Int32Array((ny + 1) * nx);
  const xi = indexOf(grid.xs);
  const yi = indexOf(grid.ys);
  walls.forEach((wall, k) => {
    const axis = wallAxis(wall);
    if (!axis) return;
    if (axis === "v") {
      const i = xi.get(wall.start.x) as number;
      const [a, b] = sorted(yi.get(wall.start.y) as number, yi.get(wall.end.y) as number);
      for (let j = a; j < b; j++) v[i * ny + j] = k + 1;
    } else {
      const j = yi.get(wall.start.y) as number;
      const [a, b] = sorted(xi.get(wall.start.x) as number, xi.get(wall.end.x) as number);
      for (let i = a; i < b; i++) h[j * nx + i] = k + 1;
    }
  });
  return { v, h };
}

/**
 * Faces: connected components of cells not separated by a barrier. Label 0 is the exterior (the
 * component touching the padded border); bounded faces are labelled 1..count-1 in scan order.
 */
export type Faces = { readonly label: Int32Array; readonly count: number };

export function labelFaces(grid: Grid, bars: Barriers): Faces {
  const { nx, ny } = grid;
  const label = new Int32Array(nx * ny).fill(-1);
  let count = 0;
  const stack: number[] = [];
  for (let start = 0; start < nx * ny; start++) {
    if (label[start] !== -1) continue;
    const id = count++;
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const c = stack.pop() as number;
      const i = c % nx;
      const j = (c - i) / nx;
      const visit = (n: number) => {
        if (label[n] === -1) {
          label[n] = id;
          stack.push(n);
        }
      };
      if (i + 1 < nx && bars.v[(i + 1) * ny + j] === 0) visit(c + 1);
      if (i > 0 && bars.v[i * ny + j] === 0) visit(c - 1);
      if (j + 1 < ny && bars.h[(j + 1) * nx + i] === 0) visit(c + nx);
      if (j > 0 && bars.h[j * nx + i] === 0) visit(c - nx);
    }
  }
  return { label, count };
}

/** Marks cells covered by any of the rectangles. Rectangle edges must lie on grid lines. */
export function cover(
  grid: Grid,
  rects: readonly { x0: number; y0: number; x1: number; y1: number }[],
): Uint8Array {
  const covered = new Uint8Array(grid.nx * grid.ny);
  const xi = indexOf(grid.xs);
  const yi = indexOf(grid.ys);
  for (const r of rects) {
    const i0 = xi.get(r.x0) as number;
    const i1 = xi.get(r.x1) as number;
    const j0 = yi.get(r.y0) as number;
    const j1 = yi.get(r.y1) as number;
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) covered[j * grid.nx + i] = 1;
    }
  }
  return covered;
}

/**
 * Traces the boundary of a set of cells into closed rings. Outer rings run counter-clockwise and holes
 * clockwise (y up). Where the region touches itself at a corner, the rings are kept separate.
 */
export function traceRings(grid: Grid, inside: (c: number) => boolean): Ring[] {
  const { nx, ny } = grid;
  const vw = nx + 1;
  const out = new Uint8Array((nx + 1) * (ny + 1) * 4);
  const used = new Uint8Array(out.length);
  const has = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && inside(j * nx + i);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!inside(j * nx + i)) continue;
      if (!has(i, j - 1)) out[(j * vw + i) * 4 + 0] = 1;
      if (!has(i + 1, j)) out[(j * vw + i + 1) * 4 + 1] = 1;
      if (!has(i, j + 1)) out[((j + 1) * vw + i + 1) * 4 + 2] = 1;
      if (!has(i - 1, j)) out[((j + 1) * vw + i) * 4 + 3] = 1;
    }
  }
  const step = [1, vw, -1, -vw];
  const rings: Ring[] = [];
  for (let e = 0; e < out.length; e++) {
    if (!out[e] || used[e]) continue;
    const vertices: number[] = [];
    const dirs: number[] = [];
    let edge = e;
    for (;;) {
      used[edge] = 1;
      const v = edge >> 2;
      const d = edge & 3;
      vertices.push(v);
      dirs.push(d);
      const next = v + (step[d] as number);
      let chosen = -1;
      for (const turn of [1, 0, 3]) {
        const candidate = next * 4 + ((d + turn) % 4);
        if (out[candidate] && (!used[candidate] || candidate === e)) {
          chosen = candidate;
          break;
        }
      }
      if (chosen === -1 || chosen === e) break;
      edge = chosen;
    }
    const ring: Point[] = [];
    for (let k = 0; k < vertices.length; k++) {
      const prev = dirs[(k + dirs.length - 1) % dirs.length];
      if (prev === dirs[k]) continue;
      const v = vertices[k] as number;
      ring.push({ x: grid.xs[v % vw] as number, y: grid.ys[Math.floor(v / vw)] as number });
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Area of the region not covered by any `width × width` square lying inside it: the parts narrower than
 * `width`. Zero means the region is at least `width` wide everywhere. Exact: maximal rectangles of a
 * rectilinear region have edges on its own boundary coordinates, so only those are enumerated.
 */
export function narrowArea(grid: Grid, inside: (c: number) => boolean, width: number): number {
  const rings = traceRings(grid, inside);
  const xs = [...new Set(rings.flatMap((r) => r.map((p) => p.x)))].sort((a, b) => a - b);
  const ys = [...new Set(rings.flatMap((r) => r.map((p) => p.y)))].sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx <= 0 || ny <= 0) return 0;
  const cells = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = ((xs[i] as number) + (xs[i + 1] as number)) / 2;
      const cy = ((ys[j] as number) + (ys[j + 1] as number)) / 2;
      const c = cellAt(grid, { x: cx, y: cy });
      cells[j * nx + i] = c >= 0 && inside(c) ? 1 : 0;
    }
  }
  const sum = new Int32Array((nx + 1) * (ny + 1));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      sum[(j + 1) * (nx + 1) + i + 1] =
        (cells[j * nx + i] as number) +
        (sum[j * (nx + 1) + i + 1] as number) +
        (sum[(j + 1) * (nx + 1) + i] as number) -
        (sum[j * (nx + 1) + i] as number);
    }
  }
  const full = (i0: number, j0: number, i1: number, j1: number) =>
    (sum[j1 * (nx + 1) + i1] as number) -
      (sum[j0 * (nx + 1) + i1] as number) -
      (sum[j1 * (nx + 1) + i0] as number) +
      (sum[j0 * (nx + 1) + i0] as number) ===
    (i1 - i0) * (j1 - j0);
  const diff = new Int32Array((nx + 1) * (ny + 1));
  for (let i0 = 0; i0 < nx; i0++) {
    for (let j0 = 0; j0 < ny; j0++) {
      if (!cells[j0 * nx + i0]) continue;
      for (let i1 = i0 + 1; i1 <= nx; i1++) {
        if (!full(i0, j0, i1, j0 + 1)) break;
        if ((xs[i1] as number) - (xs[i0] as number) < width) continue;
        for (let j1 = j0 + 1; j1 <= ny; j1++) {
          if (!full(i0, j0, i1, j1)) break;
          if ((ys[j1] as number) - (ys[j0] as number) < width) continue;
          diff[j0 * (nx + 1) + i0] = (diff[j0 * (nx + 1) + i0] as number) + 1;
          diff[j0 * (nx + 1) + i1] = (diff[j0 * (nx + 1) + i1] as number) - 1;
          diff[j1 * (nx + 1) + i0] = (diff[j1 * (nx + 1) + i0] as number) - 1;
          diff[j1 * (nx + 1) + i1] = (diff[j1 * (nx + 1) + i1] as number) + 1;
        }
      }
    }
  }
  let narrow = 0;
  const acc = new Int32Array((nx + 1) * (ny + 1));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * (nx + 1) + i;
      acc[k] =
        (diff[k] as number) +
        (i > 0 ? (acc[k - 1] as number) : 0) +
        (j > 0 ? (acc[k - (nx + 1)] as number) : 0) -
        (i > 0 && j > 0 ? (acc[k - (nx + 1) - 1] as number) : 0);
      if (cells[j * nx + i] && (acc[k] as number) <= 0) {
        narrow +=
          ((xs[i + 1] as number) - (xs[i] as number)) * ((ys[j + 1] as number) - (ys[j] as number));
      }
    }
  }
  return narrow;
}

/** Signed area of a ring (positive for counter-clockwise). */
export function ringArea(ring: Ring): number {
  let twice = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k] as Point;
    const b = ring[(k + 1) % ring.length] as Point;
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

function lowerIndex(values: readonly number[], x: number): number {
  let lo = 0;
  let hi = values.length - 1;
  if (hi < 0 || x < (values[0] as number)) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((values[mid] as number) <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function indexOf(values: readonly number[]): Map<number, number> {
  return new Map(values.map((v, k) => [v, k]));
}

function sorted(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}
