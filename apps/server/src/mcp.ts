import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  fromJsonSchema,
  type JsonSchemaType,
  McpServer,
} from "@modelcontextprotocol/server";
import { tools } from "@or1/tools";

/** One McpServer per request (stateless). Tools come from the shared registry; MCP callers get the external role. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "or1", version: "0.0.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.parameters as JsonSchemaType),
      },
      async (args) => {
        const result = await tool.execute(args, { role: "external" });
        return { content: [{ type: "text", text: result.text }] };
      },
    );
  }
  return server;
}

export function createMcpNodeHandler() {
  return toNodeHandler(createMcpHandler(() => createMcpServer()));
}
