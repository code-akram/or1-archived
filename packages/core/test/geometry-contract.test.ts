import { describe, expect, it } from "vitest";
import {
  applyChanges,
  emptyModel,
  type Model,
  type Op,
  type ProblemCode,
  type Role,
} from "../src/index.ts";
import { accept, box, build, EXT, netAreaOf, spaceIdAt, wall } from "./plans.ts";

/**
 * Hard fixtures for docs/geometry-contract.md. Expected areas are worked out by hand from the
 * centreline coordinates and thicknesses, not read back from the implementation.
 */

const kinds = (model: Model) =>
  accept(model, [])
    .derived.graph.junctions.map((j) => j.kind)
    .sort()
    .join(" ");

describe("valid topology", () => {
  it("a single room: four L junctions, exact gross, net and slab areas", () => {
    const { derived } = build(box(0, 0, 6000, 4000));
    expect(derived.problems).toEqual([]);
    expect(derived.graph.junctions.map((j) => j.kind)).toEqual(["L", "L", "L", "L"]);
    expect(derived.spaces).toHaveLength(1);
    const [room] = derived.spaces;
    expect(room?.grossArea).toBe(6000 * 4000);
    expect(room?.netArea).toBe(5800 * 3800);
    expect(room?.clear).toEqual([
      [
        { x: 100, y: 100 },
        { x: 5900, y: 100 },
        { x: 5900, y: 3900 },
        { x: 100, y: 3900 },
      ],
    ]);
    expect(derived.slab.area).toBe(6200 * 4200);
  });

  it("T junctions: a partition splits a room; the wall between them is an adjacency", () => {
    const { model, derived } = build([...box(0, 0, 6000, 4000), wall([2000, 0], [2000, 4000])]);
    expect(kinds(model)).toBe("L L L L T T");
    const left = spaceIdAt(derived, 1000, 2000);
    const right = spaceIdAt(derived, 4000, 2000);
    expect(netAreaOf(derived, left)).toBe((1950 - 100) * 3800);
    expect(netAreaOf(derived, right)).toBe((5900 - 2050) * 3800);
    const between = derived.adjacencies.filter(
      (a) => a.between.includes(left) && a.between.includes(right),
    );
    expect(between).toEqual([{ between: [left, right], wall: "W5", length: 4000 }]);
  });

  it("X junction: crossing partitions make four equal rooms", () => {
    const { model, derived } = build([
      ...box(0, 0, 6000, 4000),
      wall([3000, 0], [3000, 4000]),
      wall([0, 2000], [6000, 2000]),
    ]);
    expect(kinds(model)).toBe("L L L L T T T T X");
    expect(derived.spaces.map((s) => s.netArea)).toEqual(Array(4).fill(2850 * 1850));
    expect(derived.spaces.reduce((sum, s) => sum + s.grossArea, 0)).toBe(6000 * 4000);
  });

  it("collinear joint with a thickness change: the clear outline steps", () => {
    const { model, derived } = build([
      wall([0, 0], [3000, 0], 300),
      wall([3000, 0], [6000, 0], EXT),
      wall([6000, 0], [6000, 4000], EXT),
      wall([6000, 4000], [0, 4000], EXT),
      wall([0, 4000], [0, 0], EXT),
    ]);
    expect(kinds(model)).toBe("L L L L joint");
    const [room] = derived.spaces;
    expect(room?.netArea).toBe(5800 * 3800 - 2900 * 50);
    expect(room?.clear[0]).toHaveLength(6);
  });

  it("island core: a closed box inside the shell becomes a hole in the surrounding space", () => {
    const { derived } = build([...box(0, 0, 10000, 8000), ...box(4000, 3000, 6000, 5000, EXT)]);
    expect(derived.spaces).toHaveLength(2);
    const floor = spaceIdAt(derived, 1000, 1000);
    const core = spaceIdAt(derived, 5000, 4000);
    const floorSpace = derived.spaces.find((s) => s.id === floor);
    expect(floorSpace?.grossArea).toBe(10000 * 8000 - 2000 * 2000);
    expect(floorSpace?.netArea).toBe(9800 * 7800 - 2200 * 2200);
    expect(floorSpace?.outline).toHaveLength(2);
    expect(netAreaOf(derived, core)).toBe(1800 * 1800);
  });

  it("spur: a free-ended wall stays inside one space and its footprint is subtracted", () => {
    const { model, derived } = build([...box(0, 0, 6000, 4000), wall([3000, 0], [3000, 2000])]);
    expect(kinds(model)).toBe("L L L L T end");
    expect(derived.spaces).toHaveLength(1);
    expect(derived.spaces[0]?.netArea).toBe(5800 * 3800 - 100 * 1900);
  });

  it("a gap between collinear walls is a passage: both sides are one space", () => {
    const { derived } = build([
      ...box(0, 0, 6000, 4000),
      wall([3000, 0], [3000, 1500]),
      wall([3000, 2400], [3000, 4000]),
    ]);
    expect(derived.spaces).toHaveLength(1);
  });

  it("an L-shaped room has a six-vertex counter-clockwise outline", () => {
    const { derived } = build([
      wall([0, 0], [6000, 0], EXT),
      wall([6000, 0], [6000, 2000], EXT),
      wall([6000, 2000], [3000, 2000], EXT),
      wall([3000, 2000], [3000, 4000], EXT),
      wall([3000, 4000], [0, 4000], EXT),
      wall([0, 4000], [0, 0], EXT),
    ]);
    const [room] = derived.spaces;
    expect(room?.grossArea).toBe(6000 * 2000 + 3000 * 2000);
    expect(room?.outline[0]).toEqual([
      { x: 0, y: 0 },
      { x: 6000, y: 0 },
      { x: 6000, y: 2000 },
      { x: 3000, y: 2000 },
      { x: 3000, y: 4000 },
      { x: 0, y: 4000 },
    ]);
  });

  it("a door connects the spaces on either side of its host; a window faces the exterior", () => {
    const { derived } = build([
      ...box(0, 0, 6000, 4000),
      wall([2000, 0], [2000, 4000]),
      { op: "add_door", wall: "W5", offset: 1000, width: 900 },
      { op: "add_window", wall: "W1", offset: 3000, width: 1200 },
    ]);
    const left = spaceIdAt(derived, 1000, 2000);
    const right = spaceIdAt(derived, 4000, 2000);
    // W5 runs +y, so its left side is -x.
    expect(derived.openings).toEqual([
      { id: "O1", left, right },
      { id: "O2", left: right, right: "exterior" },
    ]);
  });
});

describe("rejected edits write nothing", () => {
  const room = build(box(0, 0, 6000, 4000)).model;

  function rejects(
    model: Model,
    ops: Op[],
    code: ProblemCode | "invalid_op" | "not_found",
    role: Role = "agent",
  ) {
    const before: Model = JSON.parse(JSON.stringify(model));
    const result = applyChanges(model, ops, role);
    expect(model).toEqual(before);
    if (result.ok) throw new Error("expected a rejection");
    if (code === "invalid_op" || code === "not_found") {
      expect(result.rejection.reason).toBe(code);
    } else {
      expect(result.rejection.reason).toBe("invalid_geometry");
      expect(result.rejection.problems?.map((p) => p.code)).toContain(code);
    }
    return result.rejection;
  }

  it("diagonal and zero-length walls", () => {
    rejects(room, [wall([1000, 1000], [2000, 2000])], "not_orthogonal");
    rejects(room, [wall([1000, 1000], [1000, 1000])], "zero_length");
  });

  it("odd, too thin and fractional thicknesses", () => {
    rejects(room, [wall([2000, 0], [2000, 4000], 101)], "bad_thickness");
    rejects(room, [wall([2000, 0], [2000, 4000], 40)], "bad_thickness");
    rejects(room, [wall([2000, 0], [2000, 4000], 100.5)], "invalid_op");
  });

  it("collinear overlap", () => {
    rejects(room, [wall([1000, 0], [2000, 0], EXT)], "overlap");
  });

  it("a wall stopping just short of another, or at its face instead of its centreline", () => {
    rejects(room, [wall([2000, 150], [2000, 4000])], "too_close");
    rejects(room, [wall([2000, 100], [2000, 4000])], "too_close");
  });

  it("a junction closer than the minimum segment to a corner", () => {
    rejects(room, [wall([60, 0], [60, 4000])], "short_segment");
  });

  it("parallel partitions and collinear gaps narrower than the minimum gap", () => {
    rejects(room, [wall([2000, 0], [2000, 4000]), wall([2250, 0], [2250, 4000])], "too_close");
    rejects(room, [wall([3000, 0], [3000, 1500]), wall([3000, 1650], [3000, 4000])], "too_close");
  });

  it.each([0, 199, 200, 201])("unjoined walls keep %i mm from extended corner bodies", (gap) => {
    for (const reverse of [false, true]) {
      for (let rotation = 0; rotation < 4; rotation++) {
        const rotate = (point: readonly [number, number]): [number, number] => {
          let [x, y] = point;
          for (let k = 0; k < rotation; k++) [x, y] = [-y, x];
          return [x, y];
        };
        const walls: [readonly [number, number], readonly [number, number], number][] = [
          [[-2000, 0], [0, 0], 600],
          [[0, 0], [0, 2000], 600],
          // At gap 0 use Oracle's collision: the third body lies inside both joined walls.
          // Otherwise its top is 199/200/201 mm below their extended bottom at y=-300.
          [[200, gap === 0 ? -250 : -350 - gap], [300, gap === 0 ? -250 : -350 - gap], 100],
        ];
        const ops = walls.map(([a, b, thickness]) =>
          wall(rotate(reverse ? b : a), rotate(reverse ? a : b), thickness),
        );
        if (gap < 200) rejects(emptyModel(), ops, "too_close");
        else build(ops);
      }
    }
  });

  it("openings off their segment, across a junction, overlapping, too narrow or on a spur", () => {
    const split = build([...box(0, 0, 6000, 4000), wall([2000, 0], [2000, 4000])]).model;
    rejects(
      split,
      [{ op: "add_door", wall: "W5", offset: 3500, width: 900 }],
      "opening_off_segment",
    );
    rejects(
      split,
      [{ op: "add_window", wall: "W1", offset: 1500, width: 1000 }],
      "opening_off_segment",
    );
    // The partition meets W1 at 2000 with half-thickness 50: [1960, 2860] enters its body.
    rejects(
      split,
      [{ op: "add_window", wall: "W1", offset: 2040, width: 900 }],
      "opening_off_segment",
    );
    accept(split, [{ op: "add_window", wall: "W1", offset: 2050, width: 900 }]);
    rejects(
      split,
      [
        { op: "add_window", wall: "W1", offset: 2500, width: 1000 },
        { op: "add_window", wall: "W1", offset: 3000, width: 1000 },
      ],
      "opening_overlap",
    );
    rejects(split, [{ op: "add_door", wall: "W5", offset: 1000, width: 50 }], "opening_too_narrow");
    const spur = build([...box(0, 0, 6000, 4000), wall([3000, 0], [3000, 2000])]).model;
    rejects(
      spur,
      [{ op: "add_door", wall: "W5", offset: 500, width: 800 }],
      "opening_not_separating",
    );
  });

  it("a batch is atomic: one bad op rejects the whole batch and names it", () => {
    const rejection = rejects(
      room,
      [wall([2000, 0], [2000, 4000]), wall([4000, 0], [5000, 1000])],
      "not_orthogonal",
    );
    expect(rejection.detail).toContain("W6");
  });

  it("unknown elements, reused IDs and unknown ops", () => {
    rejects(room, [{ op: "remove_wall", id: "W99" }], "not_found");
    rejects(room, [{ ...wall([2000, 0], [2000, 4000]), id: "W2" } as Op], "invalid_op");
    rejects(room, [{ op: "explode" } as unknown as Op], "invalid_op");
  });

  it("move_wall refuses to break a collinear joint or invert a stretched wall", () => {
    const joint = build([
      wall([0, 0], [3000, 0], 300),
      wall([3000, 0], [6000, 0], EXT),
      wall([6000, 0], [6000, 4000], EXT),
      wall([6000, 4000], [0, 4000], EXT),
      wall([0, 4000], [0, 0], EXT),
    ]).model;
    rejects(joint, [{ op: "move_wall", id: "W1", by: 500 }], "invalid_op");
    const split = build([...box(0, 0, 6000, 4000), wall([2000, 0], [2000, 4000])]).model;
    rejects(split, [{ op: "move_wall", id: "W1", by: 4000 }], "invalid_op");
  });
});

describe("protection", () => {
  const shell = build([
    ...box(0, 0, 6000, 4000, EXT, { locked: true }),
    wall([2000, 0], [2000, 4000], EXT, { structural: true }),
    wall([4000, 0], [4000, 4000]),
    wall([0, 2000], [2000, 2000]),
  ]).model;

  function forbidden(ops: Op[], role: Role = "agent") {
    const result = applyChanges(shell, ops, role);
    if (result.ok) throw new Error("expected forbidden");
    expect(result.rejection.reason).toBe("forbidden");
    return result.rejection.detail;
  }

  it("edits that leave protected walls unchanged are allowed", () => {
    // W6 and W7 slide along the locked and structural walls they end on without changing them.
    accept(shell, [{ op: "move_wall", id: "W6", by: 500 }]);
    accept(shell, [{ op: "move_wall", id: "W7", by: 500 }]);
  });

  it("changing a protected wall is forbidden, directly or by stretching it", () => {
    expect(forbidden([{ op: "move_wall", id: "W5", by: 300 }])).toContain("W5 is structural");
    // With W1 unlocked, moving it would stretch the locked side walls that end on it.
    const unlocked = accept(shell, [{ op: "update_wall", id: "W1", locked: false }], "owner").model;
    const result = applyChanges(unlocked, [{ op: "move_wall", id: "W1", by: 200 }], "agent");
    if (result.ok) throw new Error("expected forbidden");
    expect(result.rejection.reason).toBe("forbidden");
    expect(result.rejection.detail).toMatch(/W2 is locked.*move_wall W1.*stretches it/);
  });

  it("agents cannot add openings to structural walls or set protection flags", () => {
    expect(forbidden([{ op: "add_door", wall: "W5", offset: 500, width: 900 }])).toContain(
      "structural",
    );
    expect(forbidden([{ op: "update_wall", id: "W6", locked: true }])).toContain("only the owner");
    expect(
      forbidden([{ op: "add_door", wall: "W6", offset: 500, width: 900, entrance: true }]),
    ).toContain("entrance");
    expect(forbidden([{ op: "remove_wall", id: "W3" }])).toContain("W3 is locked");
  });

  it.each(["agent", "external"] as const)(
    "%s cannot remove the entrance flag by deleting its door or host",
    (role) => {
      const entrance = build([
        ...box(0, 0, 6000, 4000),
        { op: "add_door", wall: "W1", offset: 2000, width: 900, entrance: true },
      ]).model;
      for (const op of [
        { op: "remove_opening", id: "O1" },
        { op: "remove_wall", id: "W1" },
      ] as const) {
        const snapshot: Model = JSON.parse(JSON.stringify(entrance));
        const result = applyChanges(entrance, [op], role);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.rejection.reason).toBe("forbidden");
        expect(entrance).toEqual(snapshot);
        accept(entrance, [op], "owner");
      }
      accept(entrance, [{ op: "update_opening", id: "O1", width: 1000 }]);
    },
  );

  it("the owner may do all of it", () => {
    accept(shell, [{ op: "move_wall", id: "W5", by: 300 }], "owner");
    accept(
      shell,
      [{ op: "add_door", wall: "W1", offset: 2500, width: 1000, entrance: true }],
      "owner",
    );
  });

  it("opening locks are host-relative record locks, not world-placement locks", () => {
    const base = build([
      ...box(0, 0, 6000, 4000),
      { op: "add_window", wall: "W1", offset: 2000, width: 1000, locked: true },
    ]).model;
    const moved = accept(base, [{ op: "move_wall", id: "W1", by: 500 }]);
    expect(moved.model.openings).toEqual(base.openings);
    expect(moved.model.walls.find((w) => w.id === "W1")?.start).toEqual({ x: 0, y: 500 });
    const resize: Op[] = [
      { op: "resize_wall", id: "W1", start: { x: -1000, y: 0 }, end: { x: 6000, y: 0 } },
    ];
    const rejected = applyChanges(base, resize, "agent");
    expect(!rejected.ok && rejected.rejection.reason).toBe("forbidden");
    const owner = accept(base, resize, "owner");
    expect(owner.model.openings[0]?.offset).toBe(3000); // World x=2000 is unchanged.
  });
});

describe("indirect effects", () => {
  // Partition P (W5) at x=3000 with door O1; stem S (W6) from P to the right wall with door O2.
  const plan = build([
    ...box(0, 0, 6000, 4000),
    wall([3000, 0], [3000, 4000]),
    wall([3000, 2000], [6000, 2000]),
    { op: "add_door", wall: "W5", offset: 500, width: 900 },
    { op: "add_door", wall: "W6", offset: 1000, width: 900 },
  ]);

  it("moving a wall carries its openings, stretches attached walls and keeps their openings in place", () => {
    const { model, effects } = accept(plan.model, [{ op: "move_wall", id: "W5", by: -1000 }]);
    const w6 = model.walls.find((w) => w.id === "W6");
    expect(w6?.start).toEqual({ x: 2000, y: 2000 });
    expect(effects).toContainEqual({ kind: "wall_stretched", wall: "W6", by: "W5", op: 0 });
    const o1 = model.openings.find((o) => o.id === "O1");
    const o2 = model.openings.find((o) => o.id === "O2");
    expect(o1?.offset).toBe(500);
    expect(o2?.offset).toBe(2000);
  });

  it("neighbouring spaces report their new areas", () => {
    const left = spaceIdAt(plan.derived, 1000, 1000);
    const { effects } = accept(plan.model, [{ op: "move_wall", id: "W5", by: -1000 }]);
    expect(effects).toContainEqual({
      kind: "space_area_changed",
      space: left,
      from: (2950 - 100) * 3800,
      to: (1950 - 100) * 3800,
    });
  });

  it("a move that pushes a hosted opening across a junction is rejected", () => {
    const result = applyChanges(plan.model, [{ op: "move_wall", id: "W5", by: 1500 }], "agent");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.rejection.problems?.map((p) => p.code)).toContain("opening_off_segment");
  });

  it("removing a wall removes its openings and merges the spaces it separated", () => {
    const { model, derived, effects } = accept(plan.model, [{ op: "remove_wall", id: "W6" }]);
    expect(model.openings.map((o) => o.id)).toEqual(["O1"]);
    expect(effects).toContainEqual({ kind: "opening_removed", opening: "O2", host: "W6", op: 0 });
    expect(derived.spaces).toHaveLength(2);
  });

  it("resize_wall keeps hosted openings where they are", () => {
    const room = build([
      ...box(0, 0, 6000, 4000),
      { op: "add_window", wall: "W1", offset: 2000, width: 1000 },
    ]);
    // Extending W1 past the corner turns the corner into a T; the window stays at x = 2000.
    const longer = accept(room.model, [
      { op: "resize_wall", id: "W1", start: { x: -1000, y: 0 }, end: { x: 6000, y: 0 } },
    ]).model;
    expect(longer.openings[0]?.offset).toBe(3000);
    const back = accept(longer, [
      { op: "resize_wall", id: "W1", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
    ]).model;
    expect(back.openings[0]?.offset).toBe(2000);
  });
});
