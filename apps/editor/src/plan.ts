import type { Opening, Point, Ring, Wall } from "@or1/core";
import type { PlanReview } from "@or1/tools";

/** Presentation bounds only; all room/slab geometry comes from the server's derived rings. */
export function comparisonBounds(plans: readonly PlanReview[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const include = (p: Point, margin = 0) => {
    x0 = Math.min(x0, p.x - margin);
    x1 = Math.max(x1, p.x + margin);
    y0 = Math.min(y0, p.y - margin);
    y1 = Math.max(y1, p.y + margin);
  };
  for (const plan of plans) {
    for (const wall of plan.model.walls) {
      include(wall.start, wall.thickness / 2);
      include(wall.end, wall.thickness / 2);
    }
    for (const ring of plan.derived.slab.outline) for (const p of ring) include(p);
    for (const space of plan.derived.spaces)
      for (const ring of space.clear) for (const p of ring) include(p);
  }
  if (!Number.isFinite(x0)) return { x0: -500, y0: -500, width: 1000, height: 1000 };
  const padding = Math.max(x1 - x0, y1 - y0, 1000) * 0.08;
  return {
    x0: x0 - padding,
    y0: y0 - padding,
    width: x1 - x0 + 2 * padding,
    height: y1 - y0 + 2 * padding,
  };
}

export function ringsPath(rings: readonly Ring[]) {
  return rings
    .filter((ring) => ring.length)
    .map((ring) => `${ring.map((p, i) => `${i ? "L" : "M"}${p.x},${-p.y}`).join(" ")} Z`)
    .join(" ");
}

/** Offsets follow start → end, including reversed horizontal and vertical hosts. */
export function openingSegment(wall: Wall, opening: Opening) {
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  if (!length) return undefined;
  const dx = (wall.end.x - wall.start.x) / length;
  const dy = (wall.end.y - wall.start.y) / length;
  const point = (distance: number) => ({
    x: wall.start.x + dx * distance,
    y: wall.start.y + dy * distance,
  });
  return { start: point(opening.offset), end: point(opening.offset + opening.width), dx, dy };
}
