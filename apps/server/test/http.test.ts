import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { join } from "node:path";
import { dataDir, openStore } from "@or1/store";
import { MAX_TOOL_INPUT_BYTES, type ToolContext, tools } from "@or1/tools";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localOwnerConfig } from "../src/auth.ts";
import { createHttpServer } from "../src/http.ts";

const observed = vi.hoisted(() => ({ execute: vi.fn() }));
// Transport fixtures reuse existing registry schemas and defineTool validation. They are not
// substitutes for the real disk-backed review/accept integration suite.
vi.mock("@or1/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@or1/tools")>();
  const read = actual.tools.find((tool) => tool.name === "inspect_project");
  const write = actual.tools.find((tool) => tool.name === "apply_changes");
  if (!read || !write) throw new Error("Missing registry fixtures");
  return {
    ...actual,
    tools: [
      ...actual.tools.filter((tool) => !["review_option", "accept_option"].includes(tool.name)),
      ...(
        [
          ["review_option", read],
          ["accept_option", write],
        ] as const
      ).map(([name, source]) =>
        actual.defineTool({
          ...source,
          name,
          async execute(params, context) {
            observed.execute(params, context);
            if ((params as { projectId: string }).projectId === "throw")
              throw new Error("private database detail and token");
            return { text: "not the wire response", data: { ok: false, code: "ref_not_found" } };
          },
        }),
      ),
    ],
  };
});

const token = "synthetic-owner-credential-0123456789abcdef";
const authorization = `Bearer ${token}`;
const input = JSON.stringify({ projectId: "p", ref: "option" });

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("local owner HTTP transport", () => {
  const store = openStore(":memory:");
  const context: ToolContext = { role: "owner", namespace: "local-owner", store };
  const server = createHttpServer({ owner: { token, context } });
  let port: number;
  let base: string;

  beforeAll(async () => {
    port = await listen(server);
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await close(server);
    // Closing the factory-owned server must not close the injected store.
    expect(store.readState("missing", "main")).toBeNull();
    store.close();
  });

  function post(body = input, headers: Record<string, string> = {}, path = "/tools/review_option") {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", ...headers },
      body,
    });
  }

  function raw(headers: string[], body: string | Buffer = "", path = "/tools/review_option") {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, method: "POST", path, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  it("returns only ToolResult.data with trusted owner context and no-store", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, code: "ref_not_found" });
    expect(observed.execute).toHaveBeenLastCalledWith({ projectId: "p", ref: "option" }, context);
  });

  it("dispatches acceptance through its registry definition", async () => {
    const params = {
      projectId: "p",
      ref: "main",
      baseRevision: "r",
      requestId: "request",
      body: { ops: [], briefVersion: 1, baselineRevisionId: null },
    };
    const response = await post(JSON.stringify(params), {}, "/tools/accept_option");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, code: "ref_not_found" });
    expect(observed.execute).toHaveBeenLastCalledWith(params, context);
  });

  it("authenticates before parsing even malformed or oversized bodies", async () => {
    for (const credential of [
      "",
      "Bearer wrong",
      `Basic ${token}`,
      `${authorization}, ${authorization}`,
    ]) {
      const response = await post("{", { authorization: credential });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await post("x".repeat(MAX_TOOL_INPUT_BYTES + 1), { authorization: "" })).status).toBe(
      401,
    );
    const absent = await fetch(`${base}/tools/review_option`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(absent.status).toBe(401);
  });

  it("rejects duplicate and ambiguous Authorization headers", async () => {
    const response = await raw(
      [
        "Host",
        `127.0.0.1:${port}`,
        "Authorization",
        authorization,
        "aUtHoRiZaTiOn",
        authorization,
        "Content-Type",
        "application/json",
      ],
      input,
    );
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "ambiguous_header" });
  });

  it("never accepts credentials in query or body", async () => {
    const query = await fetch(`${base}/tools/review_option?token=${token}`, {
      method: "POST",
      body: input,
    });
    expect(query.status).toBe(401);
    expect((await post(input, {}, `/tools/review_option?token=${token}`)).status).toBe(400);
    expect((await post(JSON.stringify({ token }), { authorization: "" })).status).toBe(401);
  });

  it("rejects foreign Host, missing Host, and untrusted Origin without trusting forwarded headers", async () => {
    for (const host of [
      "evil.example",
      `evil.example:${port}`,
      "127.0.0.1:9999",
      "localhost.evil:4310",
    ]) {
      expect(
        (
          await raw(
            [
              "Host",
              host,
              "Authorization",
              authorization,
              "Content-Type",
              "application/json",
              "X-Forwarded-Host",
              `127.0.0.1:${port}`,
            ],
            input,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (await raw(["Authorization", authorization, "Content-Type", "application/json"], input))
        .status,
    ).toBe(400); // Node rejects a missing HTTP/1.1 Host before handing the request to the adapter.
    for (const origin of [
      "null",
      "https://evil.example",
      "http://localhost:5173.evil",
      "http://localhost:9999",
    ]) {
      expect((await post(input, { origin, "x-forwarded-host": `127.0.0.1:${port}` })).status).toBe(
        403,
      );
    }
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", base])
      expect((await post(input, { origin })).status).toBe(200);
  });

  it("rejects duplicate Host and Origin", async () => {
    for (const extra of [
      ["Host", `127.0.0.1:${port}`],
      ["Origin", base, "Origin", base],
    ]) {
      const response = await raw(
        [
          "Host",
          `127.0.0.1:${port}`,
          "Authorization",
          authorization,
          "Content-Type",
          "application/json",
          ...extra,
        ],
        input,
      );
      expect(response.status).toBe(400);
    }
  });

  it("is POST-only with no CORS/preflight and only UTF-8 JSON without content encoding", async () => {
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      const response = await fetch(`${base}/tools/review_option`, {
        method,
        headers: { authorization },
      });
      expect(response.status).toBe(405);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/json; charset=latin1",
      "",
    ]) {
      expect((await post(input, { "content-type": type })).status).toBe(415);
    }
    for (const encoding of ["gzip", "br", "identity"])
      expect((await post(input, { "content-encoding": encoding })).status).toBe(415);
    expect((await post(input, { "content-type": "application/json; charset=utf-8" })).status).toBe(
      200,
    );
  });

  it("rejects malformed JSON and invalid UTF-8", async () => {
    for (const body of ["", "{", "{}{}", "[1,]", "NaN"])
      expect((await post(body)).status).toBe(400);
    expect(
      (
        await raw(
          [
            "Host",
            `127.0.0.1:${port}`,
            "Authorization",
            authorization,
            "Content-Type",
            "application/json",
          ],
          Buffer.from([0x22, 0xff, 0x22]),
        )
      ).status,
    ).toBe(400);
  });

  it("caps actual UTF-8 bytes, both content-length and chunked uploads", async () => {
    expect((await post(`"${"😀".repeat(MAX_TOOL_INPUT_BYTES / 4)}"`)).status).toBe(413);
    const response = await raw(
      [
        "Host",
        `127.0.0.1:${port}`,
        "Authorization",
        authorization,
        "Content-Type",
        "application/json",
        "Transfer-Encoding",
        "chunked",
      ],
      `"${"é".repeat(MAX_TOOL_INPUT_BYTES / 2)}"`,
    );
    expect(response.status).toBe(413);
    // Exactly the raw byte limit passes transport; the fixture schema rejects this JSON value.
    expect((await post(`"${"x".repeat(MAX_TOOL_INPUT_BYTES - 2)}"`)).status).toBe(200);
  });

  it("retains registry depth/node limits and rejects body credential spoofing", async () => {
    observed.execute.mockClear();
    for (const extra of [
      { role: "owner" },
      { namespace: "other" },
      { runId: "run" },
      { context: { role: "owner" } },
    ]) {
      const response = await post(JSON.stringify({ projectId: "p", ref: "option", ...extra }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, code: "invalid_input" });
    }
    for (const body of [
      `${"[".repeat(66)}0${"]".repeat(66)}`,
      JSON.stringify(Array(100_001).fill(0)),
    ]) {
      const response = await post(body);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, code: "limit_exceeded" });
    }
    expect(observed.execute).not.toHaveBeenCalled();
  });

  it("survives an aborted chunked body without invoking the tool", async () => {
    observed.execute.mockClear();
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.end(
          `POST /tools/review_option HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: ${authorization}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n{`,
        );
      });
      socket.on("data", () => {});
      socket.on("error", reject);
      socket.on("close", () => resolve());
    });
    expect(observed.execute).not.toHaveBeenCalled();
    expect((await post()).status).toBe(200);
  });

  it("expires a stalled chunked body without dispatching", async () => {
    observed.execute.mockClear();
    const response = await new Promise<string>((resolve, reject) => {
      let response = "";
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /tools/review_option HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: ${authorization}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
        );
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.on("error", reject);
      socket.on("close", () => resolve(response));
    });
    expect(response).toContain("408 Request Timeout");
    expect(response).toContain('"error":"body_timeout"');
    expect(observed.execute).not.toHaveBeenCalled();
  }, 15_000);

  it("sanitizes unexpected errors and unavailable registry definitions", async () => {
    const response = await post(JSON.stringify({ projectId: "throw" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    const spy = vi.spyOn(tools, "find").mockReturnValueOnce(undefined);
    const missing = await post();
    spy.mockRestore();
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: "tool_unavailable" });
  });

  it("does not expose other tools, project writes, or model/run starts", async () => {
    for (const path of [
      "/runs",
      "/projects",
      "/tools/create_project",
      "/tools/apply_changes",
      "/tools/inspect_project",
      "/tools/start_run",
    ])
      expect((await post("{}", {}, path)).status).toBe(404);
  });

  it("does not leak the HTTP owner credential into MCP", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "inspect_project", arguments: { projectId: "p" } },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"isError":true');
    expect(body).toContain("unauthorized");
    expect(body).not.toContain(token);
  });

  it("sets finite body/header/request/socket deadlines", () => {
    expect(server.requestTimeout).toBe(15_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.timeout).toBe(15_000);
    expect(server.keepAliveTimeout).toBe(5_000);
  });
});

describe("local owner configuration", () => {
  it("is disabled without config and validates partial/invalid configuration", () => {
    expect(localOwnerConfig({}, "0.0.0.0")).toBeUndefined();
    expect(localOwnerConfig({ OR1_OWNER_TOKEN: token }, "127.0.0.1")).toEqual({
      token,
      namespace: "local-owner",
    });
    for (const host of ["127.0.0.1", "::1", "localhost"])
      expect(
        localOwnerConfig({ OR1_OWNER_TOKEN: token, OR1_OWNER_NAMESPACE: "owner:1" }, host)
          ?.namespace,
      ).toBe("owner:1");
    for (const env of [
      { OR1_OWNER_NAMESPACE: "owner" },
      { OR1_OWNER_TOKEN: "" },
      { OR1_OWNER_TOKEN: "x".repeat(31) },
      { OR1_OWNER_TOKEN: `${token} secret` },
      { OR1_OWNER_TOKEN: token, OR1_OWNER_NAMESPACE: "" },
      { OR1_OWNER_TOKEN: token, OR1_OWNER_NAMESPACE: "bad\nnamespace" },
    ])
      expect(() => localOwnerConfig(env, "127.0.0.1")).toThrow("Invalid local owner configuration");
    expect(localOwnerConfig({ OR1_OWNER_TOKEN: "x".repeat(32) }, "localhost")).toBeDefined();
    for (const host of ["0.0.0.0", "::", "192.168.1.1", "localhost.evil", "127.0.0.2"])
      expect(() => localOwnerConfig({ OR1_OWNER_TOKEN: token }, host)).toThrow("loopback");
  });

  it("rejects invalid factory role, scope, run and credential settings", () => {
    const store = openStore(":memory:");
    const context: ToolContext = { role: "owner", namespace: "local-owner", store };
    for (const override of [
      { role: "external" },
      { role: "agent" },
      { namespace: "" },
      { store: undefined },
      { scope: { projectId: "p", ref: "option" } },
      { runId: "run" },
      { token },
    ])
      expect(() =>
        createHttpServer({ owner: { token, context: { ...context, ...override } as ToolContext } }),
      ).toThrow("credentials");
    expect(() => createHttpServer({ owner: { token: "short", context } })).toThrow("credentials");
    for (const origin of [
      "https://evil.example",
      "null",
      "http://localhost:5173/path",
      "http://user@localhost:5173",
      "http://127.1:5173",
    ])
      expect(() =>
        createHttpServer({ owner: { token, context }, allowedOrigins: [origin] }),
      ).toThrow();
    store.close();
  });

  it("fails closed without config even when the caller has the correct token", async () => {
    const server = createHttpServer();
    const port = await listen(server);
    try {
      for (const name of ["review_option", "accept_option"]) {
        const response = await fetch(`http://127.0.0.1:${port}/tools/${name}`, {
          method: "POST",
          headers: { authorization },
          body: input,
        });
        expect(response.status).toBe(404);
      }
    } finally {
      await close(server);
    }
  });

  it("uses an explicit local Origin override rather than widening the default allowlist", async () => {
    const store = openStore(":memory:");
    const server = createHttpServer({
      owner: { token, context: { role: "owner", namespace: "local-owner", store } },
      allowedOrigins: ["http://localhost:5174"],
    });
    const port = await listen(server);
    try {
      for (const [origin, status] of [
        ["http://localhost:5174", 200],
        ["http://localhost:5173", 403],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${port}/tools/review_option`, {
          method: "POST",
          headers: { authorization, origin, "content-type": "application/json" },
          body: input,
        });
        expect(response.status).toBe(status);
      }
    } finally {
      await close(server);
      store.close();
    }
  });

  it("fails startup before opening storage for partial/unsafe owner config and sanitizes logs", () => {
    mkdirSync(dataDir(), { recursive: true });
    const dir = mkdtempSync(join(dataDir(), "http-startup-"));
    try {
      for (const config of [
        { OR1_OWNER_TOKEN: "short" },
        { OR1_OWNER_TOKEN: token, OR1_HOST: "0.0.0.0" },
        { OR1_OWNER_NAMESPACE: "owner" },
      ]) {
        const result = spawnSync(process.execPath, ["apps/server/src/main.ts"], {
          cwd: join(import.meta.dirname, "../../.."),
          env: {
            ...process.env,
            OR1_OWNER_TOKEN: undefined,
            OR1_OWNER_NAMESPACE: undefined,
            OR1_HOST: "127.0.0.1",
            OR1_DATA_DIR: join(dir, "unopened"),
            ...config,
          },
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("startup failed");
        expect(result.stderr).not.toContain(token);
        expect(existsSync(join(dir, "unopened"))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("opens the dataDir store only for enabled startup and logs no token", async () => {
    const registry = await vi.importActual<typeof import("@or1/tools")>("@or1/tools");
    const hasReview = registry.tools.some((tool) => tool.name === "review_option");
    mkdirSync(dataDir(), { recursive: true });
    const dir = mkdtempSync(join(dataDir(), "http-startup-"));
    try {
      for (const enabled of [false, true]) {
        const reservation = createHttpServer();
        const port = await listen(reservation);
        await close(reservation);
        const path = join(dir, enabled ? "enabled" : "disabled");
        const child = spawn(process.execPath, ["apps/server/src/main.ts"], {
          cwd: join(import.meta.dirname, "../../.."),
          env: {
            ...process.env,
            OR1_HOST: "127.0.0.1",
            OR1_PORT: String(port),
            OR1_DATA_DIR: path,
            OR1_OWNER_TOKEN: enabled ? token : undefined,
            OR1_OWNER_NAMESPACE: undefined,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let logs = "";
        const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Startup timed out")), 5_000);
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once("exit", () => {
              clearTimeout(timer);
              reject(new Error("Startup exited"));
            });
            child.stdout.on("data", (chunk) => {
              logs += chunk;
              if (logs.includes("server listening")) {
                clearTimeout(timer);
                resolve();
              }
            });
            child.stderr.on("data", (chunk) => {
              logs += chunk;
            });
          });
          expect(existsSync(join(path, "or1.sqlite"))).toBe(enabled);
          expect(logs).not.toContain(token);
          expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
          const response = await fetch(`http://127.0.0.1:${port}/tools/review_option`, {
            method: "POST",
            headers: { authorization, "content-type": "application/json" },
            body: input,
          });
          expect(response.status).toBe(enabled ? (hasReview ? 200 : 503) : 404);
          expect(await response.json()).toMatchObject(
            enabled
              ? hasReview
                ? { ok: false }
                : { error: "tool_unavailable" }
              : { error: "not_found" },
          );
        } finally {
          child.kill("SIGTERM");
          expect(await exited).toBe(0);
        }
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  }, 15_000);
});
