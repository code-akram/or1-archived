import { describe, expect, it } from "vitest";
import { wallGraph } from "../src/geometry.ts";
import { labelFaces, makeGrid, narrowArea } from "../src/grid.ts";
import {
  applyChanges,
  type Brief,
  InputError,
  LIMITS,
  migrateV1,
  scorecard,
  validateBrief,
  type Wall,
} from "../src/index.ts";
import { accept, box, build, wall } from "./plans.ts";
import { connectedPlan } from "./scorecard-fixtures.ts";

const r = (id: string) => ({ kind: "requirement" as const, id });
const brief: Brief = {
  schemaVersion: 2,
  rooms: [
    { id: "small", program: "bedroom", quantity: 1, hard: true, targetAreaM2: 16.53 },
    {
      id: "large",
      program: "bedroom",
      quantity: 1,
      hard: true,
      targetAreaM2: 28.13,
      habitable: true,
    },
  ],
  constraints: [
    { kind: "min_area", target: r("small"), areaM2: 16, hard: true },
    { kind: "min_area", target: r("large"), areaM2: 28, hard: true },
    { kind: "adjacent", a: r("small"), b: r("large"), via: "door", hard: true },
  ],
};
const model = accept(connectedPlan().model, [
  { op: "tag_space", space: "S1", program: "bedroom", requirementId: "small" },
  { op: "tag_space", space: "S2", program: "bedroom", requirementId: "large" },
]).model;

describe("v2 requirements", () => {
  it("uses one explicit assignment for counts, constraints, targets and daylight", () => {
    const result = scorecard(model, brief, model);
    expect(result.valid).toBe(true);
    expect(result.requirements).toEqual([
      { id: "small", quantity: 1, present: 1, spaces: ["S1"] },
      { id: "large", quantity: 1, present: 1, spaces: ["S2"] },
    ]);
    expect(result.scores.map((s) => [s.score, s.value])).toEqual([
      ["area_fit", 1],
      ["daylight", 1],
    ]);
    const swapped = accept(model, [
      { op: "tag_space", space: "S1", requirementId: "large" },
      { op: "tag_space", space: "S2", requirementId: null },
    ]).model;
    const failed = scorecard(swapped, brief, model);
    expect(failed.valid).toBe(false);
    expect(failed.requirements.map((q) => q.present)).toEqual([0, 1]);
    expect(failed.constraints.map((c) => c.met)).toEqual([false, false, false]);
    expect(failed.scores.find((s) => s.score === "daylight")?.value).toBe(0);
    expect(failed.scores.find((s) => s.score === "area_fit")?.value).toBeCloseTo(
      (1 - (28.13 - 16.53) / 28.13) / 2,
    );
  });

  it("quantities are minima and constraints include assigned surplus but not unassigned spaces", () => {
    const both = accept(model, [{ op: "tag_space", space: "S2", requirementId: "small" }]).model;
    const one: Brief = {
      ...brief,
      rooms: brief.rooms.slice(0, 1),
      constraints: [{ kind: "max_area", target: r("small"), areaM2: 20, hard: true }],
    };
    expect(scorecard(both, one, model).gates.find((g) => g.gate === "required_rooms")?.passed).toBe(
      true,
    );
    expect(scorecard(both, one, model).constraints[0]?.met).toBe(false);
    const free = accept(both, [{ op: "tag_space", space: "S2", requirementId: null }]).model;
    expect(scorecard(free, one, model).valid).toBe(true);
    const program: Brief = {
      ...one,
      constraints: [
        {
          kind: "max_area",
          target: { kind: "program", program: "bedroom" },
          areaM2: 20,
          hard: true,
        },
      ],
    };
    expect(scorecard(free, program, model).constraints[0]?.met).toBe(false);
  });

  it("rejects unknown or mismatched bindings atomically without requiring an already complete layout", () => {
    const bad = applyChanges(
      model,
      [{ op: "tag_space", space: "S1", requirementId: "unknown" }],
      "agent",
      brief,
    );
    expect(bad).toMatchObject({ ok: false, rejection: { reason: "invalid_binding" } });
    const mismatch = applyChanges(
      model,
      [{ op: "tag_space", space: "S1", program: "study" }],
      "agent",
      brief,
    );
    expect(mismatch).toMatchObject({ ok: false, rejection: { reason: "invalid_binding" } });
    const incomplete = applyChanges(
      model,
      [{ op: "tag_space", space: "S1", requirementId: null }],
      "agent",
      brief,
    );
    expect(incomplete.ok).toBe(true);
    if (incomplete.ok) expect(scorecard(incomplete.model, brief, model).valid).toBe(false);
    expect(model.spaces[0]?.requirementId).toBe("small");
  });

  it("rejects IDs and normalized exact specifications, not differently constrained same-type rooms", () => {
    validateBrief(brief);
    expect(() => validateBrief({ ...brief, rooms: [brief.rooms[0], brief.rooms[0]] })).toThrow(
      /duplicate requirement ID/,
    );
    const same = { id: "a", program: "study", quantity: 1, hard: true };
    expect(() =>
      validateBrief({
        schemaVersion: 2,
        rooms: [same, { ...same, id: "b", habitable: false }],
        constraints: [],
      }),
    ).toThrow(/duplicate requirement specification/);
    const constrained: Brief = {
      schemaVersion: 2,
      rooms: [same, { ...same, id: "b" }],
      constraints: [
        { kind: "min_area", target: r("a"), areaM2: 10, hard: true },
        { hard: true, areaM2: 10, target: r("b"), kind: "min_area" },
      ],
    };
    expect(() => validateBrief(constrained)).toThrow(/duplicate requirement specification/);
    constrained.constraints[1] = { kind: "min_area", target: r("b"), areaM2: 11, hard: true };
    validateBrief(constrained);
    expect(() =>
      validateBrief({
        ...constrained,
        rooms: constrained.rooms.slice(0, 1),
        constraints: [{ kind: "daylight", target: r("missing"), hard: true }],
      }),
    ).toThrow(/unknown requirement/);
  });

  it("retains only surviving identity assignments and reports retired assignments on merge", () => {
    const initial = build([
      ...box(0, 0, 8000, 6000),
      { op: "tag_space", space: "S1", program: "study", requirementId: "study" },
    ]);
    const split = accept(initial.model, [wall([3000, 0], [3000, 6000])]);
    expect(split.model.spaces.map((s) => s.requirementId)).toEqual(["study", undefined]);
    const tagged = accept(split.model, [
      { op: "tag_space", space: "S2", program: "study", requirementId: "other" },
    ]);
    const merged = accept(tagged.model, [{ op: "remove_wall", id: "W5" }]);
    expect(merged.model.spaces[0]?.requirementId).toBe("study");
    expect(merged.effects).toContainEqual(
      expect.objectContaining({ kind: "space_retired", space: "S2", requirementId: "other" }),
    );
  });

  it("keeps heuristic results blocking and explicitly non-certifying", () => {
    const result = scorecard(
      connectedPlan(899).model,
      { schemaVersion: 2, rooms: [], constraints: [] },
      model,
    );
    expect(result.certification).toBe("none");
    expect(result.gates.find((g) => g.gate === "corridor_width")).toMatchObject({
      basis: "concept_design_heuristic",
      passed: false,
    });
    expect(result.valid).toBe(false);
  });
});

describe("safe explicit v1 migration", () => {
  const oldModel = {
    ...model,
    schemaVersion: 1,
    spaces: model.spaces.map(({ requirementId: _r, ...s }) => s),
  };
  const oldBrief = {
    schemaVersion: 1,
    rooms: [{ program: "bedroom", count: 2, hard: true }],
    constraints: [{ kind: "min_area", program: "bedroom", areaM2: 10, hard: true }],
  };
  it("preserves inputs, translates default/count and retains program-wide targeting", () => {
    const before = JSON.stringify([oldModel, oldBrief]);
    const migrated = migrateV1(oldModel, oldBrief);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error(migrated.detail);
    expect(migrated.brief.rooms[0]).toMatchObject({ id: "r1", quantity: 2 });
    expect(migrated.model.spaces.map((s) => s.requirementId)).toEqual(["r1", "r1"]);
    expect(migrated.brief.constraints[0]).toMatchObject({
      target: { kind: "program", program: "bedroom" },
    });
    expect(scorecard(migrated.model, migrated.brief, migrated.model).valid).toBe(true);
    expect(JSON.stringify([oldModel, oldBrief])).toBe(before);
    const defaulted = migrateV1(oldModel, {
      ...oldBrief,
      rooms: [{ program: "bedroom", hard: true }],
    });
    expect(defaulted.ok && defaulted.brief.rooms[0]?.quantity).toBe(1);
  });
  it.each([true, false])("never infers repeated-program migration (identical=%s)", (identical) => {
    expect(
      migrateV1(oldModel, {
        ...oldBrief,
        rooms: [
          ...oldBrief.rooms,
          {
            program: "bedroom",
            hard: true,
            count: identical ? 2 : 1,
            targetAreaM2: identical ? undefined : 25,
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "review_required" });
  });
});

describe("pre-allocation safety envelope", () => {
  it("rejects coordinate overflow, counter overflow, huge batches and post-move overflow without mutation", () => {
    const before = JSON.stringify(model);
    expect(
      applyChanges(model, [{ op: "move_wall", id: "W5", by: LIMITS.dimension + 1 }], "agent"),
    ).toMatchObject({ ok: false, rejection: { reason: "limit_exceeded" } });
    expect(
      applyChanges(
        { ...model, next: { ...model.next, wall: Number.MAX_SAFE_INTEGER } },
        [],
        "agent",
      ),
    ).toMatchObject({ ok: false, rejection: { reason: "limit_exceeded" } });
    expect(
      applyChanges(
        model,
        Array.from({ length: LIMITS.operations + 1 }, () => ({
          op: "tag_space" as const,
          space: "S1" as const,
        })),
        "agent",
      ),
    ).toMatchObject({ ok: false, rejection: { reason: "limit_exceeded" } });
    const near = build([
      wall([LIMITS.coordinate - 1000, 0], [LIMITS.coordinate - 1000, 5000]),
    ]).model;
    expect(applyChanges(near, [{ op: "move_wall", id: "W1", by: 1001 }], "agent")).toMatchObject({
      ok: false,
      rejection: { reason: "limit_exceeded" },
    });
    expect(JSON.stringify(model)).toBe(before);
  });
  it("bounds the coordinate cross-product and width enumeration before allocating work", () => {
    const coordinates = Array.from({ length: 300 }, (_, i) => i * 100);
    expect(() => makeGrid(coordinates, coordinates)).toThrow(InputError);
    const grid = makeGrid(coordinates.slice(0, 80), coordinates.slice(0, 80));
    expect(() =>
      narrowArea(grid, (c) => ((c % grid.nx) + Math.floor(c / grid.nx)) % 2 === 0, 100),
    ).toThrow(/width rectangle work limit/);
  });
  it("rejects dense junction graphs and excessive face counts before expensive derivation", () => {
    const walls: Wall[] = [];
    for (let i = 0; i < 23; i++) {
      walls.push({
        id: `W${2 * i + 1}`,
        start: { x: i * 1000, y: 0 },
        end: { x: i * 1000, y: 22000 },
        thickness: 100,
        locked: false,
        structural: false,
      });
      walls.push({
        id: `W${2 * i + 2}`,
        start: { x: 0, y: i * 1000 },
        end: { x: 22000, y: i * 1000 },
        thickness: 100,
        locked: false,
        structural: false,
      });
    }
    expect(() => wallGraph(walls)).toThrow(/segment limit/);
    const lines = Array.from({ length: 20 }, (_, i) => i * 100);
    const grid = makeGrid(lines, lines);
    expect(() =>
      labelFaces(grid, {
        v: new Int32Array((grid.nx + 1) * grid.ny).fill(1),
        h: new Int32Array((grid.ny + 1) * grid.nx).fill(1),
      }),
    ).toThrow(/face limit/);
  });
});
