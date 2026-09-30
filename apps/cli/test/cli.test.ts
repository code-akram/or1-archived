import { describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";

describe("cli", () => {
  it("lists tools", () => {
    const { code, output } = run(["tools"]);
    expect(code).toBe(0);
    expect(output).toContain("inspect_project");
  });

  it("rejects unknown commands", () => {
    expect(run(["nope"]).code).toBe(1);
  });
});
