import type { AddressInfo } from "node:net";
import { tools } from "@or1/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.ts";
import { toAgentTool } from "../src/runs.ts";

describe("server", () => {
  const server = createHttpServer();
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("answers /health", async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("lists registry tools over MCP", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("inspect_project");
  });

  it("adapts registry tools to pi AgentTools", async () => {
    const [first] = tools;
    if (!first) throw new Error("registry is empty");
    const agentTool = toAgentTool(first);
    expect(agentTool.name).toBe(first.name);
    const result = await agentTool.execute("call-1", { projectId: "p1" });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });
});
