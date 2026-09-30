import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import bedroomBrief from "../../../evals/fixtures/synthetic-asymmetric-bedrooms/brief.json" with {
  type: "json",
};
import bedroomShell from "../../../evals/fixtures/synthetic-asymmetric-bedrooms/shell.json" with {
  type: "json",
};
import bedroomWitness from "../../../evals/fixtures/synthetic-asymmetric-bedrooms/witness.json" with {
  type: "json",
};
import bedroomOps from "../../../evals/fixtures/synthetic-asymmetric-bedrooms/witness-ops.json" with {
  type: "json",
};
import studyBrief from "../../../evals/fixtures/synthetic-hall-living-study/brief.json" with {
  type: "json",
};
import studyShell from "../../../evals/fixtures/synthetic-hall-living-study/shell.json" with {
  type: "json",
};
import studyWitness from "../../../evals/fixtures/synthetic-hall-living-study/witness.json" with {
  type: "json",
};
import studyOps from "../../../evals/fixtures/synthetic-hall-living-study/witness-ops.json" with {
  type: "json",
};
import {
  applyChanges,
  checkModel,
  derive,
  GATES,
  OpsSchema,
  type Scorecard,
  scorecard,
  validateBrief,
  validateModel,
} from "../src/index.ts";
import { accept, box, build } from "./plans.ts";

// These dimensions/counts are independent arithmetic, not expectations read from the witnesses.
const specifications = [
  {
    name: "synthetic-hall-living-study",
    shell: studyShell,
    brief: studyBrief,
    witness: studyWitness,
    ops: studyOps,
    width: 10000,
    height: 7000,
    entranceOffset: 4800,
    windows: [
      { wall: "W2", offset: 1500, width: 1600 },
      { wall: "W2", offset: 5000, width: 1200 },
    ],
    rooms: [
      { id: "hall", program: "hall", space: "S1", width: 1850, height: 6800 },
      { id: "living", program: "living", space: "S2", width: 7850, height: 3850 },
      { id: "study", program: "study", space: "S3", width: 7850, height: 2850 },
    ],
    walls: 6,
    doors: [
      { id: "O4", between: ["S1", "S2"], disconnected: ["S2"] },
      { id: "O5", between: ["S1", "S3"], disconnected: ["S3"] },
    ],
    boundary: { wall: "W6", requirement: "living", by: -28, area: 7850 * 3822, loss: 7850 },
  },
  {
    name: "synthetic-asymmetric-bedrooms",
    shell: bedroomShell,
    brief: bedroomBrief,
    witness: bedroomWitness,
    ops: bedroomOps,
    width: 11000,
    height: 8000,
    entranceOffset: 5300,
    windows: [
      { wall: "W2", offset: 1600, width: 1600 },
      { wall: "W3", offset: 1800, width: 1200 },
      { wall: "W3", offset: 5000, width: 1600 },
    ],
    rooms: [
      { id: "hall", program: "hall", space: "S1", width: 2050, height: 7800 },
      { id: "living", program: "living", space: "S2", width: 8650, height: 4350 },
      { id: "bedroom_large", program: "bedroom", space: "S3", width: 4900, height: 3350 },
      { id: "bedroom_small", program: "bedroom", space: "S4", width: 3650, height: 3350 },
    ],
    walls: 7,
    doors: [
      { id: "O5", between: ["S1", "S2"], disconnected: ["S2", "S4"] },
      { id: "O6", between: ["S1", "S3"], disconnected: ["S3"] },
      { id: "O7", between: ["S2", "S4"], disconnected: ["S4"] },
    ],
    boundary: { wall: "W7", requirement: "bedroom_large", by: -123, area: 4777 * 3350, loss: 3350 },
  },
] as const;

const fixtures = specifications.map((spec) => {
  const shell: unknown = spec.shell;
  const brief: unknown = spec.brief;
  const witness: unknown = spec.witness;
  const ops: unknown = spec.ops;
  validateModel(shell);
  validateBrief(brief);
  validateModel(witness);
  if (!Value.Check(OpsSchema, ops)) throw new Error(`${spec.name}: invalid witness ops`);
  return { ...spec, shell, brief, witness, ops };
});

const failed = (result: Scorecard) => result.gates.filter((g) => !g.passed).map((g) => g.gate);

describe.each(fixtures)("public synthetic fixture: $name", (fixture) => {
  const { shell, brief, witness, ops } = fixture;

  it("starts with an owner-built unpartitioned locked shell and needs construction", () => {
    const ownerBuilt = build([
      ...box(0, 0, fixture.width, fixture.height, 200, { locked: true }),
      {
        op: "add_door",
        wall: "W4",
        offset: fixture.entranceOffset,
        width: 900,
        entrance: true,
        swing: "left",
        locked: true,
      },
      ...fixture.windows.map((w) => ({ op: "add_window" as const, ...w, locked: true })),
    ]).model;
    expect(shell).toEqual(ownerBuilt);
    expect(checkModel(shell)).toEqual([]);
    expect(shell.spaces).toHaveLength(1);
    expect(shell.spaces[0]?.program).toBeUndefined();
    expect(shell.spaces[0]?.requirementId).toBeUndefined();
    expect(derive(shell).spaces[0]?.netArea).toBe((fixture.width - 200) * (fixture.height - 200));
    expect(scorecard(shell, brief, shell).valid).toBe(false);
    expect(ops.filter((op) => op.op === "add_wall")).toHaveLength(fixture.walls - 4);
    expect(ops.filter((op) => op.op === "add_door")).toHaveLength(fixture.doors.length);
  });

  it("replays the deterministic witness as agent without mutating the shell", () => {
    const before = JSON.stringify(shell);
    const result = applyChanges(shell, ops, "agent", brief);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.rejection));
    expect(result.model).toEqual(witness);
    expect(JSON.stringify(shell)).toBe(before);
    expect(checkModel(witness)).toEqual([]);
    expect(witness.walls.slice(0, 4)).toEqual(shell.walls);
    expect(witness.openings.slice(0, shell.openings.length)).toEqual(shell.openings);
  });

  it("matches independently calculated net areas, counts, door edges and every original-shell gate", () => {
    const derived = derive(witness);
    expect(witness.walls).toHaveLength(fixture.walls);
    expect(witness.openings.filter((o) => o.kind === "door")).toHaveLength(
      fixture.doors.length + 1,
    );
    expect(witness.openings.filter((o) => o.kind === "window")).toHaveLength(
      fixture.windows.length,
    );
    expect(derived.spaces.map((s) => [s.id, s.program, s.requirementId, s.netArea])).toEqual(
      fixture.rooms.map((r) => [r.space, r.program, r.id, r.width * r.height]),
    );
    for (const door of fixture.doors) {
      const sides = derived.openings.find((o) => o.id === door.id);
      expect([sides?.left, sides?.right].sort()).toEqual([...door.between].sort());
    }
    const result = scorecard(witness, brief, shell);
    expect(result.valid).toBe(true);
    expect(result.gates.map((g) => [g.gate, g.passed])).toEqual(GATES.map((g) => [g, true]));
    expect(result.constraints.every((c) => c.hard && c.met)).toBe(true);
    expect(result.requirements).toEqual(
      fixture.rooms.map((r) => ({ id: r.id, quantity: 1, present: 1, spaces: [r.space] })),
    );
    expect(result.scores.map((s) => [s.score, s.value])).toEqual([
      ["area_fit", 1],
      ["daylight", 1],
    ]);
  });

  it("fails each missing explicit assignment even when its program and geometry remain", () => {
    for (const room of fixture.rooms) {
      const missing = accept(witness, [
        { op: "tag_space", space: room.space, requirementId: null },
      ]).model;
      const result = scorecard(missing, brief, shell);
      expect(failed(result)).toEqual(["required_rooms", "hard_constraints"]);
      expect(result.requirements.map((r) => [r.id, r.present])).toEqual(
        fixture.rooms.map((r) => [r.id, r.id === room.id ? 0 : 1]),
      );
      expect(missing.spaces.find((s) => s.id === room.space)?.program).toBe(room.program);
    }
  });

  it("fails direct door adjacency and entrance connectivity when each interior door is removed", () => {
    for (const door of fixture.doors) {
      const disconnected = accept(witness, [{ op: "remove_opening", id: door.id }]).model;
      const result = scorecard(disconnected, brief, shell);
      expect(failed(result)).toEqual(["reachable", "hard_constraints"]);
      expect(
        result.gates.find((g) => g.gate === "reachable")?.failures.flatMap((f) => f.subjects),
      ).toEqual(door.disconnected);
      expect(result.constraints.filter((c) => !c.met).map((c) => c.kind)).toEqual(["adjacent"]);
    }
  });

  it("rejects a 799 mm internal door while the original 800 mm door passes", () => {
    const door = witness.openings.find((o) => o.kind === "door" && o.width === 800);
    if (!door) throw new Error("missing 800 mm door");
    const narrow = accept(witness, [{ op: "update_opening", id: door.id, width: 799 }]).model;
    expect(failed(scorecard(narrow, brief, shell))).toEqual(["door_width"]);
  });

  it("straddles a hard net-area boundary with a one-millimetre partition move", () => {
    const boundary = fixture.boundary;
    for (const extra of [0, 1]) {
      const moved = accept(witness, [
        { op: "move_wall", id: boundary.wall, by: boundary.by - extra },
      ]).model;
      expect(
        derive(moved).spaces.find((s) => s.requirementId === boundary.requirement)?.netArea,
      ).toBe(boundary.area - extra * boundary.loss);
      const result = scorecard(moved, brief, shell);
      expect(failed(result)).toEqual(extra === 0 ? [] : ["hard_constraints"]);
      expect(result.constraints.filter((c) => !c.met).map((c) => c.kind)).toEqual(
        extra === 0 ? [] : ["min_area"],
      );
    }
  });

  it("accepts exact net-area equality, but not an additional square millimetre", () => {
    const room = fixture.rooms[1];
    for (const extra of [0, 1]) {
      const boundaryBrief = {
        ...brief,
        constraints: brief.constraints.map((c) =>
          c.kind === "min_area" && c.target.kind === "requirement" && c.target.id === room.id
            ? { ...c, areaM2: (room.width * room.height + extra) / 1e6 }
            : c,
        ),
      };
      expect(failed(scorecard(witness, boundaryBrief, shell))).toEqual(
        extra === 0 ? [] : ["hard_constraints"],
      );
    }
  });
});

describe("asymmetric same-program bedroom assignments", () => {
  const fixture = fixtures[1];
  if (!fixture) throw new Error("missing asymmetric fixture");
  const { shell, brief, witness } = fixture;

  it("rejects swapped bedroom bindings despite unchanged program counts and valid bindings", () => {
    const swapped = accept(witness, [
      { op: "tag_space", space: "S3", requirementId: "bedroom_small" },
      { op: "tag_space", space: "S4", requirementId: "bedroom_large" },
    ]).model;
    const result = scorecard(swapped, brief, shell);
    expect(result.valid).toBe(false);
    expect(failed(result)).toEqual(["hard_constraints"]);
    expect(result.requirements.map((r) => r.present)).toEqual([1, 1, 1, 1]);
    // Small room cannot meet large's 16 m² minimum; both direct-access obligations also fail.
    expect(result.constraints.filter((c) => !c.met).map((c) => c.index)).toEqual([2, 5, 6]);
  });

  it("does not substitute an indirect reachable path for a required direct door", () => {
    const rerouted = accept(witness, [
      { op: "remove_opening", id: "O7" },
      { op: "add_door", wall: "W7", offset: 600, width: 800, swing: "right" },
    ]).model;
    const result = scorecard(rerouted, brief, shell);
    expect(failed(result)).toEqual(["hard_constraints"]);
    expect(result.constraints.filter((c) => !c.met).map((c) => c.index)).toEqual([6]);
  });
});
