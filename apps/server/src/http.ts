import { createServer, type Server } from "node:http";
import type { NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpNodeHandler } from "./mcp.ts";

/** HTTP API + SSE for the editor, and /mcp for external agents. Routes are stubs. */
export function createHttpServer(): Server {
  const mcp = createMcpNodeHandler();
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("event: hello\ndata: {}\n\n");
      return;
    }
    if (url.pathname === "/mcp") {
      // The SDK's duck type assumes exactOptionalPropertyTypes is off; IncomingMessage satisfies it at runtime.
      void mcp(req as NodeIncomingMessageLike, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
