import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/index.ts";
import { accept, box, build, spaceIdAt, wall } from "./plans.ts";

/** Space identity fixtures (docs/geometry-contract.md, "Space identity"). */

describe("persistence through boundary moves", () => {
  it("both rooms keep their IDs and tags even when one shrinks to a quarter", () => {
    const split = build([...box(0, 0, 6000, 4000), wall([2000, 0], [2000, 4000])]);
    const small = spaceIdAt(split.derived, 1000, 2000);
    const large = spaceIdAt(split.derived, 4000, 2000);
    const tagged = accept(split.model, [
      { op: "tag_space", space: small, program: "kitchen" },
      { op: "tag_space", space: large, program: "living" },
    ]);
    // Moving the partition to x = 5000: most of the old living room's floor now lies in the kitchen,
    // but the kitchen is still bounded by the same wall sides, so identity follows the walls.
    const moved = accept(tagged.model, [{ op: "move_wall", id: "W5", by: 3000 }]);
    expect(spaceIdAt(moved.derived, 1000, 2000)).toBe(small);
    expect(spaceIdAt(moved.derived, 5500, 2000)).toBe(large);
    expect(moved.model.spaces.map((s) => [s.id, s.program])).toEqual(
      [
        [large, "living"],
        [small, "kitchen"],
      ].sort(),
    );
    expect(
      moved.effects.filter((e) => e.kind === "space_created" || e.kind === "space_retired"),
    ).toEqual([]);
  });
});

describe("split", () => {
  it("the larger part keeps the ID and tags; the other part is new and says where it came from", () => {
    const room = build(box(0, 0, 6000, 4000));
    const [id] = room.model.spaces.map((s) => s.id);
    const tagged = accept(room.model, [{ op: "tag_space", space: id as "S1", program: "living" }]);
    const split = accept(tagged.model, [wall([2000, 0], [2000, 4000])]);
    expect(spaceIdAt(split.derived, 4000, 2000)).toBe("S1");
    expect(split.model.spaces).toContainEqual(
      expect.objectContaining({ id: "S1", program: "living" }),
    );
    expect(split.model.spaces).toContainEqual({ id: "S2", anchor: { x: 1, y: 1 } });
    expect(split.effects).toContainEqual({ kind: "space_created", space: "S2", from: "S1" });
  });

  it("an equal split keeps the ID on the lowest, then leftmost part", () => {
    const vertical = accept(build(box(0, 0, 6000, 4000)).model, [wall([3000, 0], [3000, 4000])]);
    expect(spaceIdAt(vertical.derived, 1000, 2000)).toBe("S1");
    const horizontal = accept(build(box(0, 0, 6000, 4000)).model, [wall([0, 2000], [6000, 2000])]);
    expect(spaceIdAt(horizontal.derived, 3000, 1000)).toBe("S1");
  });
});

describe("merge and disappearance", () => {
  const split = build([...box(0, 0, 6000, 4000), wall([2000, 0], [2000, 4000])]);
  const small = spaceIdAt(split.derived, 1000, 2000);
  const large = spaceIdAt(split.derived, 4000, 2000);
  const tagged = accept(split.model, [
    { op: "tag_space", space: small, program: "study", label: "Study" },
    { op: "tag_space", space: large, program: "living" },
  ]).model;

  it("the larger room survives; the absorbed one retires into it and reports its tags", () => {
    const merged = accept(tagged, [{ op: "remove_wall", id: "W5" }]);
    expect(merged.model.spaces.map((s) => [s.id, s.program])).toEqual([[large, "living"]]);
    expect(merged.effects).toContainEqual({
      kind: "space_retired",
      space: small,
      into: large,
      label: "Study",
      program: "study",
    });
  });

  it("a room opened to the exterior disappears without a successor", () => {
    // Replace the left exterior wall (W4) by nothing: the study's face joins the exterior.
    const open = applyChanges(tagged, [{ op: "remove_wall", id: "W4" }], "owner");
    if (!open.ok) throw new Error(open.rejection.detail);
    const retired = open.effects.find((e) => e.kind === "space_retired");
    expect(retired).toEqual({
      kind: "space_retired",
      space: small,
      label: "Study",
      program: "study",
    });
  });

  it("a room that reappears gets a new ID: no resurrection", () => {
    const merged = accept(tagged, [{ op: "remove_wall", id: "W5" }]).model;
    const again = accept(merged, [wall([2000, 0], [2000, 4000])]);
    const back = spaceIdAt(again.derived, 1000, 2000);
    expect(back).not.toBe(small);
    expect(back).toBe("S3");
    expect(again.model.spaces.find((s) => s.id === back)?.program).toBeUndefined();
  });
});

describe("fallback: mutual majority overlap when no wall side survives", () => {
  // A closet made of its own four walls (W5–W8) inside a shell.
  const plan = build([...box(0, 0, 10000, 8000), ...box(2000, 2000, 4000, 4000, 100)]);
  const closet = spaceIdAt(plan.derived, 3000, 3000);
  const redraw = (x: number) => [
    ...["W5", "W6", "W7", "W8"].map((id) => ({ op: "remove_wall" as const, id: id as "W5" })),
    ...box(x, 2000, x + 2000, 4000, 100),
  ];

  it("redrawn walls covering most of the old closet keep its ID", () => {
    const shifted = accept(plan.model, redraw(2100));
    expect(spaceIdAt(shifted.derived, 3000, 3000)).toBe(closet);
  });

  it.each([2999, 3000, 3001])(
    "fallback at x=%i requires strictly more than half of both faces",
    (x) => {
      const moved = accept(plan.model, redraw(x));
      expect(spaceIdAt(moved.derived, x + 1000, 3000) === closet).toBe(x < 3000);
    },
  );

  it("full overlap of the old face is insufficient if it is a minority of the new face", () => {
    const expanded = accept(plan.model, [
      ...["W5", "W6", "W7", "W8"].map((id) => ({ op: "remove_wall" as const, id: id as "W5" })),
      ...box(2000, 2000, 8000, 6000, 100),
    ]);
    expect(spaceIdAt(expanded.derived, 3000, 3000)).not.toBe(closet);
  });

  it("redrawn walls overlapping only a minority of it make a new space", () => {
    const moved = accept(plan.model, redraw(3500));
    expect(spaceIdAt(moved.derived, 4500, 3000)).not.toBe(closet);
    expect(moved.effects).toContainEqual(
      expect.objectContaining({ kind: "space_retired", space: closet }),
    );
  });
});

describe("tag_space", () => {
  const room = build(box(0, 0, 6000, 4000)).model;

  it("resolves points against the batch's final geometry, even before the split op", () => {
    const result = accept(room, [
      { op: "tag_space", space: { x: 1000, y: 2000 }, program: "bedroom" },
      wall([2000, 0], [2000, 4000]),
    ]);
    const bedroom = spaceIdAt(result.derived, 1000, 2000);
    expect(result.model.spaces.find((s) => s.id === bedroom)?.program).toBe("bedroom");
    expect(result.derived.spaces.find((s) => s.id === bedroom)?.program).toBe("bedroom");
  });

  it("null clears a tag; points in walls or outside and retired IDs are rejected", () => {
    const tagged = accept(room, [
      { op: "tag_space", space: "S1", program: "living", label: "Living" },
    ]).model;
    const cleared = accept(tagged, [{ op: "tag_space", space: "S1", program: null }]).model;
    expect(cleared.spaces[0]).toEqual({ id: "S1", anchor: { x: 1, y: 1 }, label: "Living" });
    const inWall = applyChanges(
      room,
      [{ op: "tag_space", space: { x: 0, y: 2000 }, program: "x" }],
      "agent",
    );
    expect(!inWall.ok && inWall.rejection.detail).toContain("inside a wall");
    const outside = applyChanges(
      room,
      [{ op: "tag_space", space: { x: -500, y: 0 }, program: "x" }],
      "agent",
    );
    expect(!outside.ok && outside.rejection.detail).toContain("outside every space");
    const split = accept(room, [wall([2000, 0], [2000, 4000])]).model;
    const retired = applyChanges(
      split,
      [
        { op: "remove_wall", id: "W5" },
        { op: "tag_space", space: "S2", program: "x" },
      ],
      "agent",
    );
    expect(!retired.ok && retired.rejection.detail).toContain("S2 was retired into S1");
  });
});

describe("IDs are never reused", () => {
  it("after the highest wall is removed, the next wall gets a fresh ID", () => {
    const split = build([...box(0, 0, 6000, 4000), wall([2000, 0], [2000, 4000])]).model;
    const removed = accept(split, [{ op: "remove_wall", id: "W5" }]).model;
    const added = accept(removed, [wall([3000, 0], [3000, 4000])]);
    expect(added.model.walls.map((w) => w.id)).toContain("W6");
    expect(added.model.walls.map((w) => w.id)).not.toContain("W5");
  });
});
