import { readFileSync } from "node:fs";
import { derive, type Model } from "@or1/core";
import { describe, expect, it } from "vitest";
import {
  compileBrief,
  compileProject,
  compileShell,
  PRESETS,
  type ShellDraft,
} from "../src/draft.ts";

const fixture = (name: string, file: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../evals/fixtures/${name}/${file}`, import.meta.url), "utf8"),
  );

describe("project drafts compile through core validation", () => {
  it.each([
    ["hall-living-study", "synthetic-hall-living-study"],
    ["asymmetric-bedrooms", "synthetic-asymmetric-bedrooms"],
  ])("preset %s reproduces the public fixture %s exactly", (preset, name) => {
    const draft = PRESETS.find((entry) => entry.id === preset)?.draft;
    if (!draft) throw new Error("missing preset");
    const compiled = compileProject(draft);
    if (!compiled.ok) throw new Error(compiled.message);
    const shell = fixture(name, "shell.json") as Model;
    expect(compiled.value.brief).toEqual(fixture(name, "brief.json"));
    expect(compiled.value.model.walls).toEqual(shell.walls);
    // Opening order and key order differ; identity, host, placement and flags must not.
    const sorted = (model: Model) => [...model.openings].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(compiled.value.model)).toEqual(sorted(shell));
    expect(compiled.value.model.next).toEqual(shell.next);
    expect(derive(compiled.value.model).spaces).toHaveLength(1);
  });

  it("compiles every preset", () => {
    for (const preset of PRESETS) expect(compileProject(preset.draft).ok, preset.id).toBe(true);
  });

  it("measures north and west offsets from the west and south ends", () => {
    const shell: ShellDraft = {
      width: 8000,
      depth: 5000,
      thickness: 200,
      entrance: { side: "west", offset: 1000, width: 900 },
      windows: [{ side: "north", offset: 500, width: 1200 }],
    };
    const compiled = compileShell(shell);
    if (!compiled.ok) throw new Error(compiled.message);
    // West wall W4 runs (0,5000) → (0,0): 1000 mm above the south end is host offset 3100.
    expect(compiled.value.openings.find((o) => o.wall === "W4")?.offset).toBe(3100);
    // North wall W3 runs (8000,5000) → (0,5000): 500 mm from the west end is host offset 6300.
    expect(compiled.value.openings.find((o) => o.wall === "W3")?.offset).toBe(6300);
  });

  it("reports core rejections instead of inventing geometry", () => {
    const base = PRESETS[0]?.draft.shell as ShellDraft;
    const outside = compileShell({
      ...base,
      windows: [{ side: "east", offset: 6500, width: 1000 }],
    });
    expect(outside).toMatchObject({ ok: false });
    expect(compileShell({ ...base, width: 0 })).toMatchObject({ ok: false });
    expect(compileShell({ ...base, depth: 1.5 })).toMatchObject({ ok: false });
  });

  it("rejects unknown door targets, bad IDs and duplicate requirement specifications", () => {
    const rooms = PRESETS[0]?.draft.brief.rooms ?? [];
    const hall = rooms[0];
    if (!hall) throw new Error("missing room");
    expect(compileBrief({ name: "", rooms: [{ ...hall, doorTo: ["nowhere"] }] })).toMatchObject({
      ok: false,
      message: expect.stringContaining("unknown requirement"),
    });
    expect(compileBrief({ name: "", rooms: [{ ...hall, id: "1bad" }] })).toMatchObject({
      ok: false,
    });
    expect(compileBrief({ name: "", rooms: [hall, { ...hall, id: "hall_2" }] })).toMatchObject({
      ok: false,
      message: expect.stringContaining("duplicate requirement"),
    });
    const unnamed = compileBrief({ name: "  ", rooms: [hall] });
    expect(unnamed.ok && "name" in unnamed.value).toBe(false);
  });
});
