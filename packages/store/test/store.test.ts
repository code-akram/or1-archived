import { describe, expect, it } from "vitest";
import { dataDir, openStore } from "../src/index.ts";

describe("store", () => {
  it("creates the schema", () => {
    const store = openStore(":memory:");
    const rows = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    expect(rows.map((row) => row.name)).toEqual([
      "briefs",
      "projects",
      "redlines",
      "refs",
      "request_outcomes",
      "revisions",
      "run_turns",
      "runs",
    ]);
    store.close();
  });

  it("resolves the data directory outside the repo", () => {
    expect(dataDir({ OR1_DATA_DIR: "/tmp/or1" })).toBe("/tmp/or1");
    expect(dataDir({ XDG_DATA_HOME: "/data" })).toBe("/data/or1");
  });
});
