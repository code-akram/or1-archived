import { describe, expect, it } from "vitest";
import { tools } from "../src/index.ts";

describe("tool registry", () => {
  it("has unique snake_case names", () => {
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("uses plain JSON Schema objects for parameters", () => {
    for (const tool of tools) {
      const json = JSON.parse(JSON.stringify(tool.parameters));
      expect(json.type).toBe("object");
    }
  });
});
