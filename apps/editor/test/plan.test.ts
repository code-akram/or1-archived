import type { Opening, Wall } from "@or1/core";
import { describe, expect, it } from "vitest";
import { comparisonBounds, openingSegment, ringsPath } from "../src/plan.ts";
import { reviewFixture } from "./fixtures.ts";

const opening: Opening = {
  id: "O1",
  kind: "window",
  wall: "W1",
  offset: 300,
  width: 700,
  locked: false,
};
const wall: Wall = {
  id: "W1",
  start: { x: -2000, y: 3500 },
  end: { x: -2000, y: -1500 },
  thickness: 200,
  locked: false,
  structural: false,
};

describe("SVG presentation", () => {
  it("places openings from the start of a reversed vertical host with negative coordinates", () => {
    expect(openingSegment(wall, opening)).toEqual({
      start: { x: -2000, y: 3200 },
      end: { x: -2000, y: 2500 },
      dx: 0,
      dy: -1,
    });
  });
  it("places asymmetric offsets correctly on both horizontal directions", () => {
    expect(
      openingSegment({ ...wall, start: { x: 1700, y: -900 }, end: { x: -2300, y: -900 } }, opening),
    ).toEqual({ start: { x: 1400, y: -900 }, end: { x: 700, y: -900 }, dx: -1, dy: 0 });
    expect(
      openingSegment({ ...wall, start: { x: -2300, y: -900 }, end: { x: 1700, y: -900 } }, opening)
        ?.start,
    ).toEqual({ x: -2000, y: -900 });
  });
  it("inverts Y once and preserves separate hole subpaths", () => {
    expect(
      ringsPath([
        [
          { x: -20, y: 30 },
          { x: 80, y: 30 },
          { x: 80, y: -70 },
        ],
        [
          { x: 10, y: 5 },
          { x: 40, y: -15 },
        ],
      ]),
    ).toBe("M-20,-30 L80,-30 L80,70 Z M10,-5 L40,15 Z");
  });
  it("uses both plans, negative extents, and wall thickness in shared bounds", () => {
    const fixture = reviewFixture();
    const negative = {
      ...fixture.option,
      model: { ...fixture.option.model, walls: [wall] },
      derived: { ...fixture.option.derived, slab: { outline: [], area: 0 }, spaces: [] },
    };
    const bounds = comparisonBounds([fixture.main, negative]);
    expect(bounds.x0).toBeLessThan(-2100);
    expect(bounds.y0).toBeLessThan(-1600);
    expect(bounds.x0 + bounds.width).toBeGreaterThan(8100);
    expect(bounds.y0 + bounds.height).toBeGreaterThan(6100);
  });
});
