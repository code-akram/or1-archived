import { faceAnchor, faceSet, wallCoordinates } from "./derive.ts";
import { wallAxis } from "./geometry.ts";
import { cellArea, cellAt, makeGrid } from "./grid.ts";
import { wallLimits } from "./limits.ts";
import { idNumber, type Model, type SpaceId, type SpaceRecord, type Wall } from "./model.ts";

export type SpaceEffect =
  | { readonly kind: "space_created"; readonly space: SpaceId; readonly from?: SpaceId }
  | {
      readonly kind: "space_retired";
      readonly space: SpaceId;
      readonly into?: SpaceId;
      readonly label?: string;
      readonly program?: string;
      readonly requirementId?: string;
    };

export type Reconciled = {
  readonly spaces: readonly SpaceRecord[];
  readonly nextSpace: number;
  readonly effects: readonly SpaceEffect[];
};

/**
 * Carries space identity from `before` to the faces formed by `walls` (geometry contract, "Space
 * identity"). Each old record is matched to at most one new face and vice versa:
 *
 * 1. Candidate pairs overlap by a positive area.
 * 2. Boundary continuity: rank by the number of shared wall sides (same wall ID, same side).
 * 3. Fallback: a pair sharing no wall side is a candidate only on mutual majority overlap
 *    (more than half of each face). Ties rank by overlap area, then lower old ID, then the new face
 *    that is lowest, then leftmost.
 * 4. Greedy assignment in rank order. Unmatched new faces get fresh IDs; unmatched records retire.
 */
export function reconcileSpaces(before: Model, walls: readonly Wall[]): Reconciled {
  wallLimits(before.walls);
  wallLimits(walls);
  const oldWalls = before.walls.filter((w) => wallAxis(w));
  const newWalls = walls.filter((w) => wallAxis(w));
  const a = wallCoordinates(oldWalls);
  const b = wallCoordinates(newWalls);
  const grid = makeGrid([...a.xs, ...b.xs], [...a.ys, ...b.ys]);
  const oldSet = faceSet(grid, oldWalls);
  const newSet = faceSet(grid, newWalls);
  const oldLabel = oldSet.faces.label;
  const newLabel = newSet.faces.label;
  const nNew = newSet.faces.count;

  const recordOf = new Map<number, SpaceRecord>();
  const orphans: SpaceRecord[] = [];
  for (const record of [...before.spaces].sort((p, q) => idNumber(p.id) - idNumber(q.id))) {
    const c = cellAt(grid, record.anchor);
    const f = c >= 0 ? (oldLabel[c] as number) : 0;
    if (f > 0 && !recordOf.has(f)) recordOf.set(f, record);
    else orphans.push(record);
  }

  const overlap = new Map<number, number>();
  for (let c = 0; c < grid.nx * grid.ny; c++) {
    const o = oldLabel[c] as number;
    const n = newLabel[c] as number;
    if (o === 0 || n === 0) continue;
    const key = o * nNew + n;
    overlap.set(key, (overlap.get(key) ?? 0) + cellArea(grid, c));
  }

  type Pair = { o: number; n: number; shared: number; area: number; record: SpaceRecord };
  const pairs: Pair[] = [];
  for (const [key, area] of overlap) {
    const n = key % nNew;
    const o = (key - n) / nNew;
    const record = recordOf.get(o);
    if (!record) continue;
    const oldSides = oldSet.sides[o] as ReadonlyMap<string, number>;
    let shared = 0;
    for (const side of (newSet.sides[n] as ReadonlyMap<string, number>).keys()) {
      if (oldSides.has(side)) shared++;
    }
    const majority = 2 * area > (oldSet.area[o] as number) && 2 * area > (newSet.area[n] as number);
    if (shared > 0 || majority) pairs.push({ o, n, shared, area, record });
  }
  pairs.sort(
    (p, q) =>
      q.shared - p.shared ||
      q.area - p.area ||
      idNumber(p.record.id) - idNumber(q.record.id) ||
      (newSet.first[p.n] as number) - (newSet.first[q.n] as number),
  );

  const matchedNew = new Map<number, SpaceRecord>();
  const matchedOld = new Set<number>();
  for (const pair of pairs) {
    if (matchedNew.has(pair.n) || matchedOld.has(pair.o)) continue;
    matchedNew.set(pair.n, pair.record);
    matchedOld.add(pair.o);
  }

  const largest = (from: "old" | "new", face: number): number | undefined => {
    let best: number | undefined;
    let bestArea = 0;
    for (const [key, area] of overlap) {
      const n = key % nNew;
      const o = (key - n) / nNew;
      const [mine, other] = from === "old" ? [o, n] : [n, o];
      if (mine === face && area > bestArea) {
        best = other;
        bestArea = area;
      }
    }
    return best;
  };

  let next = before.next.space;
  const idOfNew = new Map<number, SpaceId>();
  const spaces: SpaceRecord[] = [];
  const effects: SpaceEffect[] = [];
  const order = Array.from({ length: nNew - 1 }, (_, k) => k + 1).sort(
    (p, q) => (newSet.first[p] as number) - (newSet.first[q] as number),
  );
  for (const n of order) {
    const anchor = faceAnchor(grid, newSet, n);
    const record = matchedNew.get(n);
    if (record) {
      spaces.push({ ...record, anchor });
      idOfNew.set(n, record.id);
    } else {
      const id: SpaceId = `S${next++}`;
      spaces.push({ id, anchor });
      idOfNew.set(n, id);
      const o = largest("new", n);
      const from = o === undefined ? undefined : recordOf.get(o)?.id;
      effects.push(
        from ? { kind: "space_created", space: id, from } : { kind: "space_created", space: id },
      );
    }
  }
  const retired: [number | undefined, SpaceRecord][] = [
    ...[...recordOf].filter(([o]) => !matchedOld.has(o)),
    ...orphans.map((r): [undefined, SpaceRecord] => [undefined, r]),
  ];
  for (const [o, record] of retired) {
    const n = o === undefined ? undefined : largest("old", o);
    const into = n === undefined ? undefined : idOfNew.get(n);
    effects.push({
      kind: "space_retired",
      space: record.id,
      ...(into ? { into } : {}),
      ...(record.label ? { label: record.label } : {}),
      ...(record.program ? { program: record.program } : {}),
      ...(record.requirementId ? { requirementId: record.requirementId } : {}),
    });
  }
  spaces.sort((p, q) => idNumber(p.id) - idNumber(q.id));
  return { spaces, nextSpace: next, effects };
}
