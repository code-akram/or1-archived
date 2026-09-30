import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  fromJsonSchema,
  type JsonSchemaType,
  McpServer,
} from "@modelcontextprotocol/server";
import { type ToolContext, tools } from "@or1/tools";

/** Trusted authentication may supply context; anonymous callers can list schemas but access no data. */
export function createMcpServer(context: ToolContext = { role: "external" }): McpServer {
  if (context.role !== "external" || context.runId !== undefined)
    throw new Error("MCP requires external credentials without an in-app run binding");
  const server = new McpServer({ name: "or1", version: "0.0.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.parameters as JsonSchemaType),
      },
      async (args) => {
        const result = await tool.execute(args, context);
        const data = result.data as Record<string, unknown> | undefined;
        return {
          content: [{ type: "text", text: result.text }],
          ...(data ? { structuredContent: data } : {}),
          isError: data?.ok === false,
        };
      },
    );
  }
  return server;
}

export function createMcpNodeHandler(context?: ToolContext) {
  return toNodeHandler(createMcpHandler(() => createMcpServer(context)));
}
