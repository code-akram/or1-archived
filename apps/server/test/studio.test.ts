import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model as PiModel,
} from "@earendil-works/pi-ai";
import { applyChanges, type Brief, emptyModel, type Model, type Op } from "@or1/core";
import { dataDir, openStore, type Store } from "@or1/store";
import { type ProjectListing, type ProjectOverview, type ToolContext, tools } from "@or1/tools";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.ts";
import { createStudio, STRATEGIES } from "../src/studio.ts";

const model: PiModel<"openai-completions"> = {
  id: "scripted-agent",
  name: "Scripted agent",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://invalid.example",
  input: ["text"],
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 100_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const brief: Brief = {
  schemaVersion: 2,
  name: "Single office",
  rooms: [{ id: "office", program: "office", quantity: 1, hard: true }],
  constraints: [
    { kind: "min_area", target: { kind: "requirement", id: "office" }, areaM2: 20, hard: true },
  ],
};
const tag: Op = { op: "tag_space", space: "S1", program: "office", requirementId: "office" };

function shell(): Model {
  const points = [
    { x: 0, y: 0 },
    { x: 6000, y: 0 },
    { x: 6000, y: 4000 },
    { x: 0, y: 4000 },
  ];
  const result = applyChanges(
    emptyModel(),
    [
      ...points.map(
        (start, index): Op => ({
          op: "add_wall",
          start,
          end: points[(index + 1) % 4] as { x: number; y: number },
          thickness: 200,
          locked: true,
        }),
      ),
      { op: "add_door", wall: "W1", offset: 1500, width: 1000, entrance: true },
    ],
    "owner",
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.model;
}

function message(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
    usage: {
      input: 9,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/**
 * Every agent inspects, then waits until `parallel` agents have all made their first request
 * before committing. A pool that ran agents one after another would never release the barrier.
 */
function barrierAgent(parallel: number) {
  const prompts: string[] = [];
  let arrived = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const streamFn: StreamFn = async (_model, context) => {
    const first = !context.messages.some((entry) => entry.role === "assistant");
    if (first) {
      const prompt = context.messages.find((entry) => entry.role === "user");
      prompts.push(
        typeof prompt?.content === "string"
          ? prompt.content
          : (prompt?.content ?? []).map((part) => ("text" in part ? part.text : "")).join(""),
      );
      if (++arrived === parallel) release();
      await barrier;
    }
    const reply = first
      ? message([
          {
            type: "toolCall",
            id: "edit",
            name: "apply_changes",
            arguments: { body: { ops: [tag] } },
          },
        ])
      : message([{ type: "text", text: "done" }]);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: reply });
    stream.push({ type: "done", reason: reply.stopReason as "stop" | "toolUse", message: reply });
    return stream;
  };
  return { streamFn, prompts };
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tool(store: Store, name: string, params: unknown) {
  const definition = tools.find((entry) => entry.name === name);
  if (!definition) throw new Error(`missing ${name}`);
  const owner: ToolContext = { role: "owner", namespace: "studio-test-owner", store };
  return (await definition.execute(params, owner)).data as { ok: boolean } & Record<
    string,
    unknown
  >;
}

async function project(store: Store, projectId = "p") {
  const created = await tool(store, "create_project", {
    projectId,
    ref: "main",
    baseRevision: null,
    requestId: `${projectId}:create`,
    body: { model: shell(), brief },
  });
  expect(created.ok).toBe(true);
}

function studioFor(store: Store, streamFn?: StreamFn) {
  const studio = createStudio({
    store,
    owner: { role: "owner", namespace: "studio-test-owner", store },
    ...(streamFn ? { agent: { model, streamFn } } : {}),
  });
  cleanups.push(() => studio.close());
  return studio;
}

describe("multi-agent studio", () => {
  it("runs one scoped agent per new option in parallel, each with a distinct strategy", async () => {
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    await project(store);
    const main = store.readState("p", "main");
    const agent = barrierAgent(3);
    const studio = studioFor(store, agent.streamFn);
    const started = await studio.generate({ projectId: "p", count: 3, note: "Keep it simple." });
    if (!started.ok) throw new Error(started.code);
    expect(started.runs.map((run) => run.ref)).toEqual(["option-1", "option-2", "option-3"]);
    expect(new Set(started.runs.map((run) => run.strategy.id)).size).toBe(3);
    expect(studio.status().activeRuns).toHaveLength(3);
    await studio.settled();
    expect(studio.status().activeRuns).toEqual([]);

    for (const [index, run] of started.runs.entries()) {
      expect(store.readRun(run.runId)).toMatchObject({
        ref: run.ref,
        status: "done",
        outcome: "options",
        strategySeed: run.strategy,
      });
      // The agent was told its own direction plus the owner's shared note, nothing else.
      const prompt = agent.prompts.find((text) => text.includes(run.strategy.direction));
      expect(prompt, `strategy ${index}`).toContain("Owner note: Keep it simple.");
      for (const other of started.runs)
        if (other !== run) expect(prompt).not.toContain(other.strategy.direction);
    }
    expect(store.readState("p", "main")?.revisionId).toBe(main?.revisionId);

    const overview = (await tool(store, "project_overview", { projectId: "p" })) as ProjectOverview;
    expect(overview.options.map((option) => option.ref)).toEqual([
      "option-1",
      "option-2",
      "option-3",
    ]);
    for (const option of overview.options) {
      expect(option.stale).toBe(false);
      expect(option.plan.scorecard.valid).toBe(true);
      expect(option.runs).toEqual([
        expect.objectContaining({
          status: "done",
          outcome: "options",
          valid: true,
          lastEvent: { kind: "settled", reason: null },
          spend: expect.objectContaining({ toolCalls: 1, tokens: 10 }),
        }),
      ]);
    }
    const listing = (await tool(store, "list_projects", {})) as ProjectListing;
    expect(listing.projects).toEqual([
      expect.objectContaining({ projectId: "p", name: "Single office", options: 3 }),
    ]);

    // Accepting one option moves main; the siblings stay reviewable but are now stale.
    const review = (await tool(store, "review_option", { projectId: "p", ref: "option-2" })) as {
      ok: true;
      main: { revisionId: string };
      option: { revisionId: string; scorecard: { evaluatorVersion: string } };
      briefVersion: number;
      baselineRevisionId: string;
    };
    const accepted = await tool(store, "accept_option", {
      projectId: "p",
      ref: "main",
      baseRevision: review.main.revisionId,
      requestId: "accept-option-2",
      body: {
        sourceRef: "option-2",
        sourceRevisionId: review.option.revisionId,
        briefVersion: review.briefVersion,
        baselineRevisionId: review.baselineRevisionId,
        evaluatorVersion: review.option.scorecard.evaluatorVersion,
      },
    });
    expect(accepted.ok).toBe(true);
    const after = (await tool(store, "project_overview", { projectId: "p" })) as ProjectOverview;
    expect(after.options.map((option) => option.stale)).toEqual([true, true, true]);
  });

  it("continues the strategy rotation and ref numbering across batches", async () => {
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    await project(store);
    const studio = studioFor(store, barrierAgent(1).streamFn);
    const first = await studio.generate({ projectId: "p", count: 1 });
    await studio.settled();
    const second = await studio.generate({ projectId: "p", count: 1 });
    await studio.settled();
    if (!first.ok || !second.ok) throw new Error("generation rejected");
    expect([first.runs[0]?.ref, second.runs[0]?.ref]).toEqual(["option-1", "option-2"]);
    expect([first.runs[0]?.strategy, second.runs[0]?.strategy]).toEqual([
      STRATEGIES[0],
      STRATEGIES[1],
    ]);
  });

  it("uses explicitly chosen strategies and rejects unknown input", async () => {
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    await project(store);
    const studio = studioFor(store, barrierAgent(2).streamFn);
    const chosen = await studio.generate({ projectId: "p", count: 2, strategies: ["daylight"] });
    if (!chosen.ok) throw new Error(chosen.code);
    expect(chosen.runs.map((run) => run.strategy.id)).toEqual(["daylight", "daylight"]);
    await studio.settled();
    for (const [input, code] of [
      [{ projectId: "p", count: 0 }, "invalid_input"],
      [{ projectId: "p", count: 9 }, "invalid_input"],
      [{ projectId: "p", count: 1, extra: true }, "invalid_input"],
      [{ projectId: "missing", count: 1 }, "project_not_found"],
      [{ projectId: "p", count: 1, strategies: ["nope"] }, "unknown_strategy"],
    ] as const)
      expect(await studio.generate(input)).toMatchObject({ ok: false, code });
    expect(store.listRefs("p").map((ref) => ref.ref)).toEqual(["main", "option-1", "option-2"]);
  });

  it("fails closed without a configured agent and cancels active runs on request", async () => {
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    await project(store);
    expect(await studioFor(store).generate({ projectId: "p", count: 1 })).toMatchObject({
      ok: false,
      code: "agent_unavailable",
    });
    expect(store.listRefs("p")).toHaveLength(1);
    const hanging: StreamFn = () => createAssistantMessageEventStream();
    const studio = studioFor(store, hanging);
    const started = await studio.generate({ projectId: "p", count: 1 });
    if (!started.ok) throw new Error(started.code);
    const runId = started.runs[0]?.runId as string;
    expect(studio.cancel({ runId })).toEqual({ ok: true, cancelled: true });
    await studio.settled();
    expect(store.readRun(runId)?.status).toBe("cancelled");
    expect(studio.cancel({ runId })).toEqual({ ok: true, cancelled: false });
  });

  it("interrupts unfinished runs once on startup, not on each generated runner", async () => {
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    await project(store);
    const agent = barrierAgent(2);
    const studio = studioFor(store, agent.streamFn);
    const first = await studio.generate({ projectId: "p", count: 1 });
    // The second batch constructs a new runner while the first run is still running.
    const second = await studio.generate({ projectId: "p", count: 1 });
    await studio.settled();
    if (!first.ok || !second.ok) throw new Error("generation rejected");
    expect(store.readRun(first.runs[0]?.runId as string)?.status).toBe("done");
    expect(store.readRun(second.runs[0]?.runId as string)?.status).toBe("done");
  });
});

describe("studio over owner HTTP", () => {
  const token = "synthetic-owner-credential-0123456789abcdef";

  async function serve(store: Store, editorRoot?: string) {
    const context: ToolContext = { role: "owner", namespace: "local-owner", store };
    const studio = studioFor(store, barrierAgent(1).streamFn);
    const server: Server = createHttpServer({
      owner: { token, context },
      studio,
      ...(editorRoot ? { editorRoot } : {}),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return { studio, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it("requires the owner bearer for studio routes and dispatches overview through the registry", async () => {
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    await project(store);
    const { studio, base } = await serve(store);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const unauthorized = await post("/studio/generate", { projectId: "p", count: 1 });
    expect(unauthorized.status).toBe(401);
    expect(store.listRefs("p")).toHaveLength(1);
    const auth = { authorization: `Bearer ${token}` };
    const status = await (await post("/studio/status", {}, auth)).json();
    expect(status).toMatchObject({ ok: true, agent: { id: "scripted-agent" } });
    const generated = await (
      await post("/studio/generate", { projectId: "p", count: 1 }, auth)
    ).json();
    expect(generated).toMatchObject({ ok: true, runs: [{ ref: "option-1" }] });
    await studio.settled();
    const overview = await (await post("/tools/project_overview", { projectId: "p" }, auth)).json();
    expect(overview).toMatchObject({
      ok: true,
      options: [{ ref: "option-1", runs: [{ outcome: "options" }] }],
    });
    // Agent-internal and unlisted tools are not owner HTTP routes.
    expect((await post("/tools/apply_changes", {}, auth)).status).toBe(404);
    expect((await post("/tools/fork_ref", {}, auth)).status).toBe(404);
  });

  it("serves the built editor same-origin with /api routing, SPA fallback and no traversal", async () => {
    mkdirSync(dataDir(), { recursive: true });
    const root = mkdtempSync(join(dataDir(), "studio-editor-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>or1</title>");
    writeFileSync(join(root, "assets", "app.js"), "export {};");
    writeFileSync(join(root, "..", "studio-secret.txt"), "outside");
    cleanups.push(() => rmSync(join(root, "..", "studio-secret.txt"), { force: true }));
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    await project(store);
    const { base } = await serve(store, root);
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("<title>or1</title>");
    const script = await fetch(`${base}/assets/app.js`);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await (await fetch(`${base}/projects/p`)).text()).toContain("<title>or1</title>");
    for (const path of [
      "/assets/missing.js",
      "/%2e%2e/studio-secret.txt",
      "/..%2fstudio-secret.txt",
    ])
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    expect((await fetch(`${base}/api/session`)).status).toBe(404);
    const api = await fetch(`${base}/api/tools/list_projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(await api.json()).toMatchObject({ ok: true, projects: [{ projectId: "p" }] });
    // DNS-rebinding guard: a foreign Host never gets the editor either.
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/`, { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(foreign).toBe(403);
  });
});
