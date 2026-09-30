import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  type Brief,
  BriefSchema,
  type Constraint,
  checkModel,
  derive,
  GATES,
  type Model,
  ModelSchema,
  scorecard,
} from "../src/index.ts";
import { accept, box, build, spaceIdAt, wall } from "./plans.ts";
import { connectedPlan, scorecardFixtures, testFitBrief } from "./scorecard-fixtures.ts";

const base = connectedPlan().model;
const failed = (model: Model, brief: Brief = testFitBrief, original = base) =>
  scorecard(model, brief, original)
    .gates.filter((g) => !g.passed)
    .map((g) => g.gate);
const withConstraints = (constraints: Constraint[]): Brief => ({ ...testFitBrief, constraints });

describe("labelled scorecard fixtures and brief schema", () => {
  it.each(scorecardFixtures)("$name", ({ feasible, brief, failedGates }) => {
    expect(Value.Check(BriefSchema, brief)).toBe(true);
    const result = scorecard(base, brief, base);
    expect(result.valid).toBe(feasible);
    expect(result.gates.map((g) => g.gate)).toEqual(GATES);
    expect(result.gates.filter((g) => !g.passed).map((g) => g.gate)).toEqual(failedGates);
    expect(result.scores.map((s) => [s.score, s.value])).toEqual([
      ["area_fit", 1],
      ["daylight", 1],
    ]);
  });

  it("rejects invalid room counts, dimensions, programs and unknown fields", () => {
    for (const room of [
      { program: "living", hard: true, count: 0 },
      { program: "Living room", hard: true },
      { program: "living", hard: true, targetAreaM2: 0 },
      { program: "living", hard: true, extra: true },
    ]) {
      expect(Value.Check(BriefSchema, { ...testFitBrief, rooms: [room] })).toBe(false);
    }
    expect(Value.Check(BriefSchema, { ...testFitBrief, thresholds: { doorWidth: 800.5 } })).toBe(
      false,
    );
    expect(
      Value.Check(BriefSchema, { ...testFitBrief, constraints: [{ kind: "unknown", hard: true }] }),
    ).toBe(false);
  });
});

describe("hard gates cannot be offset by perfect soft scores", () => {
  it.each([false, true])(
    "rejects duplicate space IDs across distinct faces (reversed=%s)",
    (reversed) => {
      const isolated = accept(base, [{ op: "remove_opening", id: "O2" }]).model;
      const brief: Brief = { schemaVersion: 1, rooms: [], constraints: [] };
      expect(failed(isolated, brief, isolated)).toEqual(["reachable"]);
      const records = reversed ? [...isolated.spaces].reverse() : isolated.spaces;
      const aliased: Model = {
        ...isolated,
        spaces: records.map((s) => ({ ...s, id: "S1" })),
      };
      expect(Value.Check(ModelSchema, aliased)).toBe(true);
      expect(checkModel(aliased)).toContainEqual({
        code: "duplicate_id",
        detail: "S1 is used twice",
        subjects: ["S1"],
      });
      const result = scorecard(aliased, brief, isolated);
      expect(result.valid).toBe(false);
      expect(result.gates.find((g) => g.gate === "topology")?.passed).toBe(false);
      // Invalid records must not overwrite the first face or duplicate its derived geometry.
      expect(derive(aliased).spaces.map((s) => [s.id, s.netArea])).toEqual([
        ["S1", reversed ? 28130000 : 16530000],
      ]);
    },
  );

  it("baseline opening protection compares hosted records rather than physical positions", () => {
    const original = accept(
      base,
      [
        ...base.walls.map((w) => ({ op: "update_wall" as const, id: w.id, locked: false })),
        { op: "update_opening", id: "O3", locked: true },
      ],
      "owner",
    ).model;
    const moved = accept(original, [{ op: "move_wall", id: "W2", by: 500 }]).model;
    expect(failed(moved, testFitBrief, original)).toEqual([]);
    expect(moved.openings).toEqual(original.openings);
    const resized = accept(
      original,
      [{ op: "resize_wall", id: "W2", start: { x: 8000, y: -1000 }, end: { x: 8000, y: 6000 } }],
      "owner",
    ).model;
    expect(failed(resized, testFitBrief, original)).toEqual(["protected_intact"]);
  });

  it("reports topology and protection even on a model not produced by applyChanges", () => {
    const corrupt = {
      ...base,
      walls: base.walls.map((w) => (w.id === "W1" ? { ...w, thickness: 201 } : w)),
    };
    expect(failed(corrupt)).toContain("topology");
    expect(failed(corrupt)).toContain("protected_intact");
    const changed = accept(base, [{ op: "update_wall", id: "W1", locked: false }], "owner").model;
    expect(failed(changed)).toEqual(["protected_intact"]);
    expect(scorecard(changed, testFitBrief, base).scores.every((s) => s.value === 1)).toBe(true);
  });

  it("protects locked openings, structural hosts, and additions to protected walls", () => {
    const guarded = accept(
      base,
      [
        { op: "update_wall", id: "W1", locked: false, structural: true },
        { op: "update_opening", id: "O2", locked: true },
      ],
      "owner",
    ).model;
    for (const ops of [
      [{ op: "update_opening", id: "O2", swing: "left" }],
      [{ op: "remove_opening", id: "O3" }],
      [{ op: "add_window", wall: "W1", offset: 4000, width: 1000 }],
    ] as const) {
      const changed = accept(guarded, ops, "owner").model;
      expect(failed(changed, testFitBrief, guarded)).toContain("protected_intact");
    }
    const tagged = accept(guarded, [{ op: "tag_space", space: "S1", label: "Hall" }]).model;
    expect(failed(tagged, testFitBrief, guarded)).toEqual([]);
  });

  it("required counts are minima; missing soft rooms do not invalidate an option", () => {
    const brief: Brief = {
      ...testFitBrief,
      rooms: [
        { program: "living", count: 2, hard: true },
        { program: "study", hard: false },
        { program: "corridor", hard: false },
      ],
    };
    const result = scorecard(base, brief, base);
    expect(result.valid).toBe(false);
    expect(failed(base, brief)).toEqual(["required_rooms"]);
    expect(result.scores).toContainEqual(
      expect.objectContaining({ score: "soft_rooms", value: 0.5 }),
    );
    expect(
      failed(base, { ...brief, rooms: brief.rooms.map((r) => ({ ...r, hard: false })) }),
    ).toEqual([]);
  });

  it("reachability uses doors, not windows, wall contact, or a path through the exterior", () => {
    const isolated = accept(
      base,
      [
        { op: "remove_opening", id: "O2" },
        { op: "add_window", wall: "W5", offset: 2200, width: 800 },
        { op: "add_door", wall: "W2", offset: 4000, width: 900 },
      ],
      "owner",
    ).model;
    expect(failed(isolated)).toContain("reachable");
    expect(failed(isolated, { ...testFitBrief, unreachable: ["living"] })).not.toContain(
      "reachable",
    );
    const entrance = accept(
      isolated,
      [{ op: "update_opening", id: "O5", entrance: true }],
      "owner",
    ).model;
    expect(failed(entrance)).not.toContain("reachable");
  });

  it("an internal door marked entrance is not an entrance from the exterior", () => {
    const internal = accept(
      base,
      [
        { op: "remove_opening", id: "O1" },
        { op: "update_opening", id: "O2", entrance: true },
      ],
      "owner",
    ).model;
    expect(failed(internal)).toContain("reachable");
  });

  it("no entrance fails even if all room programs are exempt", () => {
    const none = accept(base, [{ op: "remove_opening", id: "O1" }], "owner").model;
    expect(failed(none, { ...testFitBrief, unreachable: ["living", "corridor"] })).toContain(
      "reachable",
    );
  });

  it.each([899, 900, 901])("corridor clear width %i mm (not centreline width)", (width) => {
    const model = connectedPlan(width).model;
    expect(failed(model, testFitBrief, model).includes("corridor_width")).toBe(width < 900);
    expect(
      failed(model, { ...testFitBrief, thresholds: { corridorWidth: 899 } }, model),
    ).not.toContain("corridor_width");
    expect(failed(model, { ...testFitBrief, circulation: [] }, model)).not.toContain(
      "corridor_width",
    );
  });

  it.each([
    ["O1", 899, true],
    ["O1", 900, false],
    ["O2", 799, true],
    ["O2", 800, false],
  ] as const)("door %s at %i mm: width failure = %s", (id, width, fails) => {
    const model = accept(base, [{ op: "update_opening", id, width }], "owner").model;
    expect(failed(model).includes("door_width")).toBe(fails);
    expect(
      failed(model, { ...testFitBrief, thresholds: { doorWidth: 799, entranceDoorWidth: 899 } }),
    ).not.toContain("door_width");
  });

  it.each([899, 900, 901])("door sweep against a wall %i mm away", (width) => {
    const model = connectedPlan(width).model;
    const inward = accept(
      model,
      [{ op: "update_opening", id: "O1", swing: "left" }],
      "owner",
    ).model;
    expect(failed(inward, testFitBrief, inward).includes("door_clearance")).toBe(width < 900);
  });

  it("detects a narrow spur passage rather than just checking a space's bounding box", () => {
    const plan = build([
      ...box(0, 0, 6000, 4000),
      wall([3000, 0], [3000, 3100]),
      { op: "add_door", wall: "W4", offset: 1000, width: 900, entrance: true },
      { op: "tag_space", space: { x: 1000, y: 1000 }, program: "corridor" },
    ]).model;
    // Passage over the spur: 3900 - 3100 = 800 mm, despite a 5800 × 3800 bounding box.
    expect(failed(plan, { schemaVersion: 1, rooms: [], constraints: [] }, plan)).toEqual([
      "corridor_width",
    ]);
    expect(
      failed(
        plan,
        { schemaVersion: 1, rooms: [], constraints: [], thresholds: { corridorWidth: 800 } },
        plan,
      ),
    ).toEqual([]);
  });
});

describe("hard and soft constraints", () => {
  it.each([
    [{ kind: "min_area", program: "corridor", areaM2: 16.53, hard: true }, true],
    [{ kind: "max_area", program: "corridor", areaM2: 16.53, hard: true }, true],
    [{ kind: "min_area", program: "living", areaM2: 28.13, hard: true }, true],
    [{ kind: "min_area", program: "living", areaM2: 28.130001, hard: true }, false],
    [{ kind: "max_area", program: "living", areaM2: 28.13, hard: true }, true],
    [{ kind: "max_area", program: "living", areaM2: 28.129999, hard: true }, false],
    [{ kind: "min_width", program: "living", width: 4850, hard: true }, true],
    [{ kind: "min_width", program: "living", width: 4851, hard: true }, false],
    [{ kind: "daylight", program: "living", hard: true }, true],
    [{ kind: "daylight", program: "corridor", hard: true }, false],
  ] satisfies [Constraint, boolean][])("%j: met = %s", (constraint, met) => {
    const result = scorecard(base, withConstraints([constraint]), base);
    expect(result.constraints[0]?.met).toBe(met);
    expect(result.valid).toBe(met);
    const soft = scorecard(base, withConstraints([{ ...constraint, hard: false }]), base);
    expect(soft.valid).toBe(true);
    expect(soft.scores).toContainEqual(
      expect.objectContaining({ score: "soft_constraints", value: met ? 1 : 0 }),
    );
  });

  it("wall adjacency survives removal of a door; door adjacency does not", () => {
    const model = accept(base, [{ op: "remove_opening", id: "O2" }]).model;
    const brief = withConstraints([
      { kind: "adjacent", a: "living", b: "corridor", via: "wall", hard: false },
      { kind: "adjacent", a: "living", b: "corridor", via: "door", hard: false },
    ]);
    expect(scorecard(model, brief, base).constraints.map((c) => c.met)).toEqual([true, false]);
    expect(scorecard(model, brief, base).scores).toContainEqual(
      expect.objectContaining({ score: "soft_constraints", value: 0.5 }),
    );
  });

  it("checks every matching space, not just one, and never passes vacuously for missing programs", () => {
    const both = accept(base, [{ op: "tag_space", space: "S1", program: "living" }]).model;
    const constraints: Constraint[] = [
      { kind: "min_area", program: "living", areaM2: 20, hard: true },
      { kind: "min_area", program: "missing", areaM2: 1, hard: true },
      { kind: "adjacent", a: "living", b: "missing", via: "wall", hard: true },
      { kind: "adjacent", a: "missing", b: "living", via: "door", hard: true },
      { kind: "adjacent", a: "living", b: "living", via: "door", hard: true },
    ];
    const result = scorecard(both, withConstraints(constraints), base);
    expect(result.constraints.map((c) => c.met)).toEqual([false, false, false, false, true]);
    expect(result.constraints[0]?.failures[0]?.subjects).toEqual(["S1"]);
  });

  it("an internal window is not daylight, and a missing habitable program scores zero", () => {
    const model = accept(
      base,
      [
        { op: "remove_opening", id: "O3" },
        { op: "add_window", wall: "W5", offset: 4000, width: 1000 },
      ],
      "owner",
    ).model;
    expect(scorecard(model, testFitBrief, base).scores).toContainEqual(
      expect.objectContaining({ score: "daylight", value: 0 }),
    );
    const brief: Brief = {
      schemaVersion: 1,
      rooms: [{ program: "bedroom", hard: false, habitable: true }],
      constraints: [],
    };
    expect(scorecard(base, brief, base).scores).toContainEqual(
      expect.objectContaining({ score: "daylight", value: 0 }),
    );
  });
});

describe("area fit", () => {
  const plan = connectedPlan();
  const corridor = spaceIdAt(plan.derived, 1000, 3000);
  const both = accept(plan.model, [{ op: "tag_space", space: corridor, program: "living" }]).model;

  it("uses closest surplus spaces, caps deviation, and charges each missing instance", () => {
    const brief: Brief = {
      schemaVersion: 1,
      rooms: [
        { program: "living", count: 3, hard: false, targetAreaM2: 20 },
        { program: "study", hard: false, targetAreaM2: 5 },
      ],
      constraints: [],
    };
    // Independent areas: 16.53 and 28.13 m². Deviations: .1735, .4065, 1, 1.
    expect(
      scorecard(both, brief, base).scores.find((s) => s.score === "area_fit")?.value,
    ).toBeCloseTo(0.355);
    const one = { ...brief, rooms: [{ program: "living", hard: false, targetAreaM2: 20 }] };
    expect(
      scorecard(both, one, base).scores.find((s) => s.score === "area_fit")?.value,
    ).toBeCloseTo(0.8265);
    const tiny = { ...brief, rooms: [{ program: "living", hard: false, targetAreaM2: 1 }] };
    expect(scorecard(both, tiny, base).scores.find((s) => s.score === "area_fit")?.value).toBe(0);
  });

  it("omits scores that have no brief inputs and leaves both inputs untouched", () => {
    const brief: Brief = { schemaVersion: 1, rooms: [], constraints: [] };
    const beforeModel: Model = JSON.parse(JSON.stringify(base));
    const beforeBrief: Brief = JSON.parse(JSON.stringify(brief));
    expect(scorecard(base, brief, base).scores).toEqual([]);
    expect(base).toEqual(beforeModel);
    expect(brief).toEqual(beforeBrief);
  });
});
