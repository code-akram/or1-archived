import type { Role } from "@or1/core";
import type { Static, TSchema } from "typebox";

/** Per-call context supplied by the adapter (pi agent, MCP, HTTP or CLI). The role comes from credentials. */
export type ToolContext = {
  readonly role: Role;
};

export type ToolResult = {
  /** Model-facing summary. */
  readonly text: string;
  /** Structured result for programmatic callers and the UI. */
  readonly data?: unknown;
};

/**
 * One tool definition. The TypeBox schema is plain JSON Schema, so the same definition generates
 * pi AgentTools, MCP tools (via fromJsonSchema), HTTP handlers and CLI commands.
 */
export type ToolDefinition<P extends TSchema = TSchema> = {
  readonly name: string;
  readonly description: string;
  readonly parameters: P;
  /** Mutating tools commit through apply_changes; read tools never write. */
  readonly mutates: boolean;
  execute(params: Static<P>, ctx: ToolContext): Promise<ToolResult>;
};

export function defineTool<P extends TSchema>(tool: ToolDefinition<P>): ToolDefinition<P> {
  return tool;
}
