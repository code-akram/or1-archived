import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@or1/tools";

/**
 * Adapts a registry tool to a pi AgentTool for in-app runs, with the agent role.
 *
 * Run orchestrator (not implemented yet): one pi `Agent` per option ref, `toolExecution: "sequential"`,
 * `beforeToolCall` for early rejection, run records and turns persisted in the store.
 */
export function toAgentTool(tool: ToolDefinition): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_toolCallId, params) {
      const result = await tool.execute(params, { role: "agent" });
      return { content: [{ type: "text", text: result.text }], details: undefined };
    },
  };
}
