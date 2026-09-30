import fc from "fast-check";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  applyChanges,
  checkModel,
  derive,
  type Model,
  ModelSchema,
  type Op,
  type OpeningId,
  type Ring,
  type SpaceId,
  type WallId,
} from "../src/index.ts";
import { accept, box, build, netAreaOf, spaceIdAt, wall } from "./plans.ts";

/** Shoelace area, independently of the core's grid/ring helpers. */
function polygonArea(rings: readonly Ring[]): number {
  return rings.reduce(
    (area, ring) =>
      area +
      ring.reduce((sum, a, k) => {
        const b = ring[(k + 1) % ring.length];
        if (!b) throw new Error("empty ring");
        return sum + a.x * b.y - b.x * a.y;
      }, 0) /
        2,
    0,
  );
}

function invariants(model: Model, previous: Model, retired: Set<SpaceId>) {
  expect(Value.Check(ModelSchema, model)).toBe(true);
  expect(checkModel(model)).toEqual([]);
  const geometry = derive(model);
  expect(new Set(model.spaces.map((s) => s.id)).size).toBe(model.spaces.length);
  for (const s of previous.spaces) {
    if (!model.spaces.some((next) => next.id === s.id)) retired.add(s.id);
  }
  for (const s of geometry.spaces) {
    expect(retired.has(s.id)).toBe(false);
    expect(Number.isSafeInteger(s.netArea)).toBe(true);
    expect(s.netArea).toBeGreaterThan(0);
    expect(s.netArea).toBeLessThanOrEqual(s.grossArea);
    expect(polygonArea(s.outline)).toBe(s.grossArea);
    expect(polygonArea(s.clear)).toBe(s.netArea);
  }
  expect(polygonArea(geometry.slab.outline)).toBe(geometry.slab.area);
  for (const kind of ["wall", "opening", "space"] as const) {
    expect(model.next[kind]).toBeGreaterThanOrEqual(previous.next[kind]);
    const elements =
      kind === "wall" ? model.walls : kind === "opening" ? model.openings : model.spaces;
    for (const element of elements)
      expect(Number(element.id.slice(1))).toBeLessThan(model.next[kind]);
  }
  expect(geometry.openings).toHaveLength(model.openings.length);
  for (const opening of geometry.openings) expect(opening.left).not.toBe(opening.right);
}

describe("geometry invariants across random operation sequences", () => {
  it("split, move, resize thickness, tag, host openings and merge with an independent area/identity oracle", () => {
    const action = fc.record({
      kind: fc.constantFrom("toggle", "move", "thickness", "door", "tag", "invalid"),
      x: fc.integer({ min: 1500, max: 6500 }),
      thickness: fc.integer({ min: 25, max: 150 }).map((n) => 2 * n),
      tag: fc.constantFrom("bedroom", "living", "study"),
    });
    fc.assert(
      fc.property(fc.array(action, { minLength: 15, maxLength: 40 }), (actions) => {
        let model = build([
          ...box(0, 0, 8000, 6000),
          { op: "add_window", wall: "W1", offset: 400, width: 900 },
        ]).model;
        let partition: WallId | undefined;
        let door: OpeningId | undefined;
        let x = 3000;
        let thickness = 100;
        let left: SpaceId = "S1";
        let right: SpaceId = "S1";
        const retired = new Set<SpaceId>();

        for (const action of actions) {
          const previous = model;
          const snapshot: Model = JSON.parse(JSON.stringify(model));
          let ops: Op[];
          const oldLeft = left;
          const oldRight = right;
          switch (action.kind) {
            case "toggle":
              if (partition) {
                ops = [{ op: "remove_wall", id: partition }];
                // Equal boundary-side counts: gross overlap decides; equal areas prefer lower old ID.
                const survivor =
                  x < 4000
                    ? right
                    : x > 4000
                      ? left
                      : Number(left.slice(1)) < Number(right.slice(1))
                        ? left
                        : right;
                left = survivor;
                right = survivor;
                partition = undefined;
                door = undefined;
              } else {
                x = action.x;
                thickness = action.thickness;
                partition = `W${model.next.wall}`;
                ops = [wall([x, 0], [x, 6000], thickness)];
                // The larger child keeps the old ID; an equal split keeps the left child.
                const fresh: SpaceId = `S${model.next.space}`;
                [left, right] = x >= 4000 ? [left, fresh] : [fresh, left];
              }
              break;
            case "move":
              if (!partition) continue;
              ops = [{ op: "move_wall", id: partition, by: action.x - x }];
              x = action.x;
              break;
            case "thickness":
              if (!partition) continue;
              ops = [{ op: "update_wall", id: partition, thickness: action.thickness }];
              thickness = action.thickness;
              break;
            case "door":
              if (!partition) continue;
              if (door) {
                ops = [{ op: "remove_opening", id: door }];
                door = undefined;
              } else {
                door = `O${model.next.opening}`;
                ops = [{ op: "add_door", wall: partition, offset: 1700, width: 850 }];
              }
              break;
            case "tag":
              ops = [{ op: "tag_space", space: left, program: action.tag }];
              break;
            case "invalid": {
              // A real draft edit followed by a diagonal wall: neither tags nor counters may leak.
              const result = applyChanges(
                model,
                [
                  { op: "tag_space", space: left, program: action.tag },
                  wall([action.x, 1000], [action.x + 500, 1500]),
                ],
                "agent",
              );
              expect(result.ok).toBe(false);
              if (!result.ok) expect(result.rejection.reason).toBe("invalid_geometry");
              expect(model).toEqual(snapshot);
              continue;
            }
          }
          const result = accept(model, ops);
          expect(previous).toEqual(snapshot);
          expect(applyChanges(previous, ops, "agent")).toEqual(result);
          model = result.model;
          invariants(model, previous, retired);
          expect(result.derived).toEqual(derive(model));
          expect(model.spaces).toHaveLength(partition ? 2 : 1);
          expect(spaceIdAt(result.derived, 500, 3000)).toBe(left);
          expect(spaceIdAt(result.derived, 7500, 3000)).toBe(right);
          expect(result.derived.slab.area).toBe(8200 * 6200);
          expect(result.derived.spaces.reduce((sum, s) => sum + s.grossArea, 0)).toBe(8000 * 6000);
          if (partition) {
            expect(netAreaOf(result.derived, left)).toBe((x - thickness / 2 - 100) * 5800);
            expect(netAreaOf(result.derived, right)).toBe((7900 - x - thickness / 2) * 5800);
          } else expect(netAreaOf(result.derived, left)).toBe(7800 * 5800);
          if (action.kind !== "tag") {
            for (const s of model.spaces) {
              const old = snapshot.spaces.find((p) => p.id === s.id);
              expect(s.program).toBe(old?.program);
            }
          } else expect(model.spaces.find((s) => s.id === left)?.program).toBe(action.tag);
          if (action.kind === "move" || action.kind === "thickness") {
            expect([left, right]).toEqual([oldLeft, oldRight]);
            expect(
              result.effects.filter(
                (e) => e.kind === "space_created" || e.kind === "space_retired",
              ),
            ).toEqual([]);
          }
          expect(model.openings.map((o) => o.id)).toEqual(door ? ["O1", door] : ["O1"]);
          if (door)
            expect(result.derived.openings.find((o) => o.id === door)).toEqual({
              id: door,
              left,
              right,
            });
        }
      }),
      { numRuns: 150 },
    );
  }, 15_000);

  it("moving a shell boundary stretches neighbours and preserves hosted openings in world coordinates", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 10, maxLength: 30 }),
        fc.boolean(),
        (positions, reverse) => {
          const partition = reverse ? wall([3000, 6000], [3000, 0]) : wall([3000, 0], [3000, 6000]);
          let model = build([
            ...box(0, 0, 8000, 6000),
            partition,
            { op: "add_door", wall: "W5", offset: reverse ? 3450 : 1700, width: 850 },
            { op: "add_window", wall: "W2", offset: 2500, width: 1200 },
          ]).model;
          let bottom = 0;
          const retired = new Set<SpaceId>();
          for (const y of positions) {
            const before = model;
            const snapshot: Model = JSON.parse(JSON.stringify(before));
            const result = accept(model, [{ op: "move_wall", id: "W1", by: y - bottom }]);
            expect(before).toEqual(snapshot);
            model = result.model;
            bottom = y;
            invariants(model, before, retired);
            expect(model.spaces.map((s) => s.id)).toEqual(["S1", "S2"]);
            expect(netAreaOf(result.derived, "S1")).toBe(2850 * (5800 - y));
            expect(netAreaOf(result.derived, "S2")).toBe(4850 * (5800 - y));
            expect(result.derived.slab.area).toBe(8200 * (6200 - y));
            expect(model.openings.find((o) => o.id === "O1")?.offset).toBe(
              reverse ? 3450 : 1700 - y,
            );
            expect(model.openings.find((o) => o.id === "O2")?.offset).toBe(2500 - y);
            expect(model.walls.find((w) => w.id === "W5")?.[reverse ? "end" : "start"]).toEqual({
              x: 3000,
              y,
            });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
