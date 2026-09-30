import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "./registry.ts";

export type { ToolContext, ToolDefinition, ToolResult } from "./registry.ts";
export { defineTool } from "./registry.ts";

/** Stub read tool. The V0 surface: inspect, spatial queries, apply_changes, scorecard, render_plan. */
export const inspectProject = defineTool({
  name: "inspect_project",
  description:
    "Summarise a project: walls, openings, spaces and the current head revision of a ref.",
  parameters: Type.Object({
    projectId: Type.String(),
    ref: Type.Optional(Type.String({ default: "main" })),
  }),
  mutates: false,
  async execute(params) {
    return { text: `inspect_project is not implemented yet (project ${params.projectId})` };
  },
});

export const tools: readonly ToolDefinition[] = [inspectProject];
