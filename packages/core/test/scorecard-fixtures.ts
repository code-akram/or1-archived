import type { Brief } from "../src/index.ts";
import { box, build, EXT, wall } from "./plans.ts";

/** Public, synthetic layouts. Feasibility is known from dimensions, not an agent outcome. */
export function connectedPlan(corridorWidth = 2850) {
  const x = corridorWidth + 150; // 100 mm exterior half-thickness + 50 mm partition half-thickness.
  return build([
    ...box(0, 0, 8000, 6000, EXT, { locked: true }),
    wall([x, 0], [x, 6000]),
    { op: "add_door", wall: "W4", offset: 1500, width: 900, entrance: true, swing: "right" },
    { op: "add_door", wall: "W5", offset: 2200, width: 800, swing: "right" },
    { op: "add_window", wall: "W2", offset: 1800, width: 1200 },
    { op: "tag_space", space: { x: 500, y: 3000 }, program: "corridor" },
    { op: "tag_space", space: { x: 7000, y: 3000 }, program: "living" },
  ]);
}

export const testFitBrief: Brief = {
  schemaVersion: 1,
  name: "Synthetic two-room test-fit",
  rooms: [
    { program: "corridor", hard: true, targetAreaM2: 16.53 }, // 2850 × 5800 mm.
    { program: "living", hard: true, targetAreaM2: 28.13, habitable: true }, // 4850 × 5800 mm.
  ],
  constraints: [
    { kind: "min_area", program: "living", areaM2: 28, hard: true },
    { kind: "adjacent", a: "living", b: "corridor", via: "door", hard: true },
  ],
};

export const scorecardFixtures = [
  {
    name: "connected, daylit two-room layout",
    feasible: true,
    brief: testFitBrief,
    failedGates: [],
  },
  {
    name: "100 m² living room inside a 48 m² centreline shell",
    feasible: false,
    brief: {
      ...testFitBrief,
      constraints: [
        ...testFitBrief.constraints,
        { kind: "min_area", program: "living", areaM2: 100, hard: true },
      ],
    } satisfies Brief,
    failedGates: ["hard_constraints"],
  },
] as const;
