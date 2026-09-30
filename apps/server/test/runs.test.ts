import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model as PiModel,
} from "@earendil-works/pi-ai";
import { applyChanges, type Brief, emptyModel, type Model, type Op, scorecard } from "@or1/core";
import { dataDir, openStore, type Store } from "@or1/store";
import { type ToolContext, tools } from "@or1/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areaEnvelopeEvidence,
  createRunRunner,
  DEFAULT_RUN_BUDGET,
  runRequestId,
} from "../src/runs.ts";

const model: PiModel<"openai-completions"> = {
  id: "deterministic-test",
  name: "deterministic-test",
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
  rooms: [{ id: "office", program: "office", quantity: 1, hard: true, targetAreaM2: 22.04 }],
  constraints: [
    { kind: "min_area", target: { kind: "requirement", id: "office" }, areaM2: 20, hard: true },
  ],
};
const tag: Op = { op: "tag_space", space: "S1", program: "office", requirementId: "office" };
const owner = (store: Store): ToolContext => ({ role: "owner", store, namespace: "test-owner" });

async function execute(store: Store, name: string, args: unknown) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  const result = await tool.execute(args, owner(store));
  if (!(result.data as { ok: boolean })?.ok) throw new Error(JSON.stringify(result));
  return result.data;
}

function shell(): Model {
  const points = [
    { x: 0, y: 0 },
    { x: 6000, y: 0 },
    { x: 6000, y: 4000 },
    { x: 0, y: 4000 },
  ];
  const walls: Op[] = points.map((start, index) => ({
    op: "add_wall",
    start,
    end: points[(index + 1) % 4] as { x: number; y: number },
    thickness: 200,
    locked: true,
  }));
  const result = applyChanges(
    emptyModel(),
    [
      ...walls,
      {
        op: "add_door",
        wall: "W1",
        offset: 1500,
        width: 1000,
        entrance: true,
      },
    ],
    "owner",
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.model;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function setup(customBrief = brief, path = ":memory:") {
  const store = openStore(path);
  cleanups.push(() => store.close());
  await execute(store, "create_project", {
    projectId: "p",
    ref: "main",
    baseRevision: null,
    requestId: "create",
    body: { model: shell(), brief: customBrief },
  });
  const initial = store.readState("p", "main");
  if (!initial) throw new Error("Missing fixture state");
  await execute(store, "fork_ref", {
    projectId: "p",
    ref: "option",
    baseRevision: initial.revisionId,
    requestId: "fork",
    body: { sourceRef: "main" },
  });
  const context: ToolContext = {
    role: "agent",
    store,
    namespace: "trusted-credential",
    scope: { projectId: "p", ref: "option" },
  };
  return { store, initial, context };
}

function call(id: string, ops: readonly Op[] = [tag]): AssistantMessage["content"][number] {
  return { type: "toolCall", id, name: "apply_changes", arguments: { body: { ops } } };
}
function answer(
  content: AssistantMessage["content"] = [{ type: "text", text: "done" }],
  tokens = 10,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
    usage: {
      input: tokens - 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function script(
  messages: AssistantMessage[],
  before?: (index: number) => void | Promise<void>,
): StreamFn {
  let index = 0;
  return async () => {
    const next = index++;
    await before?.(next);
    const message = messages[next] ?? answer();
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
}
function runner(fixture: Awaited<ReturnType<typeof setup>>, streamFn: StreamFn) {
  return createRunRunner({ store: fixture.store, context: fixture.context, model, streamFn });
}
function settled(store: Store, id = "run") {
  const turn = store.readRunTurns(id).at(-1);
  return turn as {
    transcript: { kind: string; reason: string | null };
    spend: {
      tokens: number;
      toolCalls: number;
      rejections: number;
      transcriptBytes: number;
    };
  };
}

describe("bounded persisted pi workflow", () => {
  it("commits a feasible option, reloads its revision, and pins the exact fresh core score", async () => {
    mkdirSync(dataDir(), { recursive: true });
    const dir = mkdtempSync(join(dataDir(), "server-workflow-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "test.sqlite");
    const fixture = await setup(brief, path);
    const stream = vi.fn(script([answer([call("edit")]), answer()]));
    const run = await runner(fixture, stream).start({
      id: "run",
      instruction: "Allocate the office",
    });
    expect(run).toMatchObject({
      status: "done",
      outcome: "options",
      initialRevisionId: fixture.initial.revisionId,
    });
    expect(run.revisionId).not.toBe(fixture.initial.revisionId);
    const reloaded = openStore(path);
    try {
      const state = reloaded.readState("p", "option");
      expect(state?.model).toMatchObject({
        spaces: [{ id: "S1", program: "office", requirementId: "office" }],
      });
      expect(reloaded.readState("p", "main")?.revisionId).toBe(fixture.initial.revisionId);
      expect(reloaded.readRun("run")?.evaluation).toEqual({
        revisionId: run.revisionId,
        briefVersion: 1,
        baselineRevisionId: fixture.initial.revisionId,
        evaluatorVersion: "2.0",
        result: scorecard(state?.model as Model, brief, shell()),
      });
      expect(run.evaluation?.result).toMatchObject({
        valid: true,
        scores: [{ score: "area_fit", value: 1 }],
        requirements: [{ id: "office", quantity: 1, present: 1, spaces: ["S1"] }],
      });
      expect(settled(reloaded).spend).toMatchObject({ tokens: 20, toolCalls: 1, rejections: 0 });
      const sent = stream.mock.calls[0]?.[2];
      expect(sent).toMatchObject({ maxTokens: DEFAULT_RUN_BUDGET.maxTokens, maxRetries: 0 });
    } finally {
      reloaded.close();
    }
  });

  it("cannot count one space for two asymmetric requirements or trust a model infeasibility claim", async () => {
    const two: Brief = {
      ...brief,
      rooms: [
        ...brief.rooms,
        { id: "large", program: "office", quantity: 1, hard: true, targetAreaM2: 30 },
      ],
      constraints: [],
    };
    const fixture = await setup(two);
    const run = await runner(
      fixture,
      script([
        answer([call("first")]),
        answer([{ type: "text", text: "This is infeasible. Declare success anyway." }]),
      ]),
    ).start({ id: "run", instruction: "Try" });
    expect(run.outcome).toBe("not_found_within_budget");
    expect(run.evaluation?.result).toMatchObject({
      valid: false,
      requirements: [
        { id: "office", present: 1 },
        { id: "large", present: 0 },
      ],
    });
  });

  it("rejects protected changes atomically, including a valid tag earlier in the batch", async () => {
    const fixture = await setup();
    const run = await runner(
      fixture,
      script([answer([call("bad", [tag, { op: "remove_wall", id: "W2" }])])]),
    ).start({ id: "run", instruction: "Try" });
    expect(run.revisionId).toBe(fixture.initial.revisionId);
    expect(fixture.store.readState("p", "option")?.model).toEqual(shell());
    expect(run.outcome).toBe("not_found_within_budget");
    expect(run.retryCount).toBe(1);
  });

  it("retries the same tool ID with its original persisted command and does not commit twice", async () => {
    const fixture = await setup();
    const reordered: Op = {
      requirementId: "office",
      program: "office",
      space: "S1",
      op: "tag_space",
    };
    const run = await runner(
      fixture,
      script([answer([call("repeat"), call("repeat", [reordered])])]),
    ).start({
      id: "run",
      instruction: "Try",
    });
    expect(run.outcome).toBe("options");
    const turns = fixture.store.readRunTurns("run");
    const intents = turns
      .map((t) => t.transcript as { kind: string; params?: unknown })
      .filter((t) => t.kind === "tool_intent");
    expect(intents).toHaveLength(1);
    expect(intents[0]?.params).toEqual({
      projectId: "p",
      ref: "option",
      baseRevision: fixture.initial.revisionId,
      requestId: runRequestId("run", "repeat"),
      body: { ops: [tag], briefVersion: 1, baselineRevisionId: fixture.initial.revisionId },
    });
    const results = turns.filter((t) => (t.transcript as { kind: string }).kind === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]?.result).toEqual(results[1]?.result);
    expect(fixture.store.readSnapshot("p", run.revisionId as string)).toEqual(
      fixture.store.readState("p", "option")?.model,
    );
  });

  it.each(["option", "main", "brief"])(
    "fails stale when an unrelated %s write arrives after scoring",
    async (target) => {
      const fixture = await setup();
      const stream = script(
        [
          answer([
            call("edit"),
            { type: "toolCall", id: "score", name: "scorecard", arguments: {} },
          ]),
          answer(),
        ],
        async (index) => {
          if (index !== 1) return;
          const ref = target === "option" ? "option" : "main";
          const state = fixture.store.readState("p", ref);
          if (!state) throw new Error("missing state");
          if (target === "brief") {
            await execute(fixture.store, "set_brief", {
              projectId: "p",
              ref,
              baseRevision: state.revisionId,
              requestId: "outside",
              baseBriefVersion: state.brief.version,
              body: { brief: { ...brief, name: "changed" } },
            });
          } else {
            await execute(fixture.store, "apply_changes", {
              projectId: "p",
              ref,
              baseRevision: state.revisionId,
              requestId: "outside",
              body: {
                ops: [{ op: "tag_space", space: "S1", label: "outside" }],
                briefVersion: state.brief.version,
                baselineRevisionId: state.forkBase?.revisionId ?? null,
              },
            });
          }
        },
      );
      const run = await runner(fixture, stream).start({ id: "run", instruction: "Try" });
      expect(run).toMatchObject({ status: "failed", outcome: null, evaluation: null });
      expect(run.revisionId).not.toBe(fixture.initial.revisionId);
      expect(settled(fixture.store).transcript.reason).toBe("stale_or_finished_run");
    },
  );

  it("blocks same-ID changed commands instead of replaying a different payload", async () => {
    const fixture = await setup();
    await runner(
      fixture,
      script([
        answer([
          call("same"),
          call("same", [{ op: "tag_space", space: "S1", label: "different" }]),
        ]),
      ]),
    ).start({ id: "run", instruction: "Try" });
    expect(fixture.store.readState("p", "option")?.model).toMatchObject({
      spaces: [{ requirementId: "office" }],
    });
    expect(
      (fixture.store.readSnapshot("p", fixture.store.readRun("run")?.revisionId as string) as Model)
        .spaces[0]?.label,
    ).toBeUndefined();
    expect(fixture.store.readRun("run")?.retryCount).toBe(1);
  });

  it.each([
    { budget: { maxTokens: 10 }, expected: "token_limit", committed: false },
    { budget: { maxToolCalls: 1 }, expected: "tool_limit", committed: true },
    { budget: { maxRejections: 1 }, expected: "rejection_limit", committed: false },
  ])(
    "synchronously enforces $expected before subsequent writes",
    async ({ budget, expected, committed }) => {
      const fixture = await setup();
      const first =
        expected === "rejection_limit"
          ? call("bad", [{ op: "remove_wall", id: "W1" }])
          : call("first");
      const second = call("second", [{ op: "tag_space", space: "S1", label: "must-not-commit" }]);
      const run = await runner(fixture, script([answer([first, second])])).start({
        id: "run",
        instruction: "Try",
        budget,
      });
      expect(run.outcome).toBe("not_found_within_budget");
      expect(settled(fixture.store).transcript.reason).toBe(expected);
      expect(run.revisionId === fixture.initial.revisionId).toBe(!committed);
      expect(
        (fixture.store.readSnapshot("p", run.revisionId as string) as Model).spaces[0]?.label,
      ).toBeUndefined();
      expect(settled(fixture.store).spend.tokens).toBe(10);
    },
  );

  it("bounds invalid/unknown tool calls as rejections before another provider request", async () => {
    const fixture = await setup();
    const driver = vi.fn(
      script([
        answer([{ type: "toolCall", id: "shell", name: "shell", arguments: {} }, call("after")]),
      ]),
    );
    const run = await runner(fixture, driver).start({
      id: "run",
      instruction: "Try",
      budget: { maxRejections: 1 },
    });
    expect(run.revisionId).toBe(fixture.initial.revisionId);
    expect(driver).toHaveBeenCalledTimes(1);
    expect(settled(fixture.store).spend).toMatchObject({ toolCalls: 1, rejections: 1 });
  });

  it("counts invalid same-ID attempts against the tool cap even after an admitted call", async () => {
    const fixture = await setup();
    const invalid = {
      type: "toolCall" as const,
      id: "same",
      name: "apply_changes",
      arguments: { body: { ops: "invalid" } },
    };
    const driver = vi.fn(script([answer([call("same"), invalid, invalid, call("after")])]));
    const run = await runner(fixture, driver).start({
      id: "run",
      instruction: "Try",
      budget: { maxToolCalls: 2, maxRejections: 10 },
    });
    expect(run.outcome).toBe("not_found_within_budget");
    expect(driver).toHaveBeenCalledTimes(1);
    expect(settled(fixture.store).transcript.reason).toBe("tool_limit");
    expect(settled(fixture.store).spend).toMatchObject({ toolCalls: 2, rejections: 1 });
    expect(
      fixture.store
        .readRunTurns("run")
        .filter((turn) => (turn.transcript as { kind: string }).kind === "tool_intent"),
    ).toHaveLength(1);
  });

  it("explicitly aborts on subscriber persistence faults instead of executing a fallback turn", async () => {
    const fixture = await setup();
    const original = fixture.store.saveRunTurn;
    vi.spyOn(fixture.store, "saveRunTurn").mockImplementation((turn) => {
      const transcript = turn.transcript as { kind: string; message?: { role: string } };
      if (transcript.kind === "message" && transcript.message?.role === "assistant")
        throw new Error("injected_persistence_fault");
      original(turn);
    });
    const run = await runner(fixture, script([answer([call("edit")])])).start({
      id: "run",
      instruction: "Try",
    });
    expect(run.outcome).toBe("not_found_within_budget");
    expect(run.revisionId).toBe(fixture.initial.revisionId);
    expect(settled(fixture.store).transcript.reason).toBe("injected_persistence_fault");
    expect(settled(fixture.store).spend.tokens).toBe(10);
  });

  it.each([0, 5500])(
    "reserves serialized bytes for high-escape settlement reasons near the cap (%s)",
    async (padding) => {
      const fixture = await setup();
      const original = fixture.store.saveRunTurn;
      const reason = "\u0000".repeat(256);
      vi.spyOn(fixture.store, "saveRunTurn").mockImplementation((turn) => {
        if ((turn.transcript as { kind: string }).kind === "tool_attempt") throw new Error(reason);
        original(turn);
      });
      const run = await runner(
        fixture,
        script([answer([{ type: "text", text: "x".repeat(padding) }, call("edit")])]),
      ).start({ id: "run", instruction: "Try", budget: { maxTranscriptBytes: 8192 } });
      expect(run.outcome).toBe("not_found_within_budget");
      expect(run.revisionId).toBe(fixture.initial.revisionId);
      const actual = fixture.store
        .readRunTurns("run")
        .reduce(
          (sum, turn) =>
            sum +
            Buffer.byteLength(JSON.stringify(turn.transcript)) +
            Buffer.byteLength(JSON.stringify(turn.result)) +
            Buffer.byteLength(JSON.stringify(turn.spend)),
          0,
        );
      expect(actual).toBeLessThanOrEqual(8192);
      expect(settled(fixture.store).spend.transcriptBytes).toBeLessThanOrEqual(8192);
      if (padding === 0) expect(settled(fixture.store).transcript.reason).toBe(reason);
    },
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed/overflow token usage %s before any model tool runs",
    async (tokens) => {
      const fixture = await setup();
      const run = await runner(fixture, script([answer([call("edit")], tokens)])).start({
        id: "run",
        instruction: "Try",
      });
      expect(run.outcome).toBe("not_found_within_budget");
      expect(run.revisionId).toBe(fixture.initial.revisionId);
      expect(settled(fixture.store).transcript.reason).toBe("invalid_token_accounting");
      expect(settled(fixture.store).spend.tokens).toBe(0);
    },
  );

  it("core resource rejection is synchronous and atomic before later admitted calls", async () => {
    const fixture = await setup();
    const run = await runner(
      fixture,
      script([
        answer([
          call(
            "oversized",
            Array.from({ length: 257 }, () => tag),
          ),
          call("after"),
        ]),
      ]),
    ).start({ id: "run", instruction: "Try", budget: { maxRejections: 1 } });
    expect(run.revisionId).toBe(fixture.initial.revisionId);
    const result = fixture.store
      .readRunTurns("run")
      .find((turn) => (turn.transcript as { kind: string }).kind === "tool_result");
    expect(result?.result).toMatchObject({
      isError: true,
      details: { ok: false, code: "limit_exceeded" },
    });
    expect(settled(fixture.store).spend).toMatchObject({ toolCalls: 1, rejections: 1 });
  });

  it("does not append an async tool result or run the next tool after cancellation", async () => {
    const fixture = await setup();
    const apply = tools.find((tool) => tool.name === "apply_changes");
    if (!apply) throw new Error("missing apply tool");
    const original = apply.execute;
    let release = () => {};
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    let didCommit = () => {};
    const committed = new Promise<void>((resolve) => {
      didCommit = resolve;
    });
    vi.spyOn(apply, "execute").mockImplementation(async (args, context) => {
      const result = await original(args, context);
      didCommit();
      await delay;
      return result;
    });
    const controller = new AbortController();
    const task = runner(
      fixture,
      script([
        answer([call("first"), call("after", [{ op: "tag_space", space: "S1", label: "late" }])]),
      ]),
    ).start({ id: "run", instruction: "Try", signal: controller.signal });
    await committed;
    controller.abort();
    const run = await task;
    const turns = fixture.store.readRunTurns("run");
    expect(run.status).toBe("cancelled");
    expect(run.revisionId).not.toBe(fixture.initial.revisionId);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.store.readRunTurns("run")).toEqual(turns);
    expect(fixture.store.readSnapshot("p", run.revisionId as string)).toMatchObject({
      spaces: [{ requirementId: "office" }],
    });
    expect(
      (fixture.store.readSnapshot("p", run.revisionId as string) as Model).spaces[0]?.label,
    ).toBeUndefined();
  });

  it("closes the store run gate before a timed-out tool resumes its deferred commit", async () => {
    const fixture = await setup();
    const apply = tools.find((tool) => tool.name === "apply_changes");
    if (!apply) throw new Error("missing apply tool");
    const original = apply.execute;
    let release = () => {};
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began = () => {};
    const entered = new Promise<void>((resolve) => {
      began = resolve;
    });
    const executeSpy = vi.spyOn(apply, "execute").mockImplementation(async (args, context) => {
      began();
      await delay;
      return original(args, context);
    });
    vi.useFakeTimers();
    const task = runner(fixture, script([answer([call("deferred")])])).start({
      id: "run",
      instruction: "Try",
      budget: { maxDurationMs: 50 },
    });
    await entered;
    await vi.advanceTimersByTimeAsync(50);
    const run = await task;
    const turns = fixture.store.readRunTurns("run");
    release();
    await vi.advanceTimersByTimeAsync(0);
    const response = await executeSpy.mock.results[0]?.value;
    expect(response.data).toMatchObject({ ok: false, code: "run_not_running" });
    expect(run.outcome).toBe("not_found_within_budget");
    expect(fixture.store.readState("p", "option")?.revisionId).toBe(fixture.initial.revisionId);
    expect(fixture.store.readRunTurns("run")).toEqual(turns);
    expect(settled(fixture.store).transcript.reason).toBe("timeout");
  });

  it("bounds UTF-8 transcript bytes before exposing tools, not JS character length", async () => {
    const fixture = await setup();
    const run = await runner(
      fixture,
      script([answer([{ type: "text", text: "界".repeat(24_000) }, call("edit")])]),
    ).start({ id: "run", instruction: "Try" });
    expect(run.revisionId).toBe(fixture.initial.revisionId);
    expect(settled(fixture.store).transcript.reason).toBe("transcript_limit");
    for (const turn of fixture.store.readRunTurns("run")) {
      const total =
        Buffer.byteLength(JSON.stringify(turn.transcript)) +
        Buffer.byteLength(JSON.stringify(turn.result)) +
        Buffer.byteLength(JSON.stringify(turn.spend));
      expect(total).toBeLessThanOrEqual(65_536);
    }
    expect(settled(fixture.store).spend.transcriptBytes).toBeLessThanOrEqual(
      DEFAULT_RUN_BUDGET.maxTranscriptBytes,
    );
  });

  it("detects timeout synchronously even when event-loop timers have not fired", async () => {
    const fixture = await setup();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const run = await runner(
      fixture,
      script([answer([call("edit")])], () => {
        now = 1100;
      }),
    ).start({ id: "run", instruction: "Try", budget: { maxDurationMs: 50 } });
    expect(run.revisionId).toBe(fixture.initial.revisionId);
    expect(settled(fixture.store).transcript.reason).toBe("timeout");
  });

  it.each(["cancelled", "timeout"])(
    "settles %s promptly but blocks new runs until the noncooperative prompt actually settles",
    async (reason) => {
      const fixture = await setup();
      const controller = new AbortController();
      const stream = createAssistantMessageEventStream();
      let began = () => {};
      const entered = new Promise<void>((resolve) => {
        began = resolve;
      });
      let count = 0;
      const next = script([answer([call("next")]), answer()]);
      const driver: StreamFn = (selected, transcript, settings) => {
        if (count++ === 0) {
          began();
          return stream;
        }
        return next(selected, transcript, settings);
      };
      vi.useFakeTimers();
      const owningRunner = runner(fixture, driver);
      const task = owningRunner.start({
        id: "run",
        instruction: "Try",
        signal: controller.signal,
        budget: { maxDurationMs: 50 },
      });
      await entered;
      if (reason === "cancelled") controller.abort();
      else await vi.advanceTimersByTimeAsync(50);
      const run = await task;
      expect(run.status).toBe(reason === "cancelled" ? "cancelled" : "done");
      const turns = fixture.store.readRunTurns("run");
      for (const id of ["blocked1", "blocked2", "blocked3"]) {
        await expect(owningRunner.start({ id, instruction: "Try again" })).rejects.toThrow(
          "not settled",
        );
        expect(fixture.store.readRun(id)).toBeNull();
      }
      expect(count).toBe(1);
      const message = answer([call("late")]);
      if (reason === "timeout") {
        stream.push({
          type: "error",
          reason: "error",
          error: { ...message, stopReason: "error", errorMessage: "late provider error" },
        });
      } else {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.store.readState("p", "option")?.revisionId).toBe(fixture.initial.revisionId);
      expect(fixture.store.readRunTurns("run")).toEqual(turns);
      expect(settled(fixture.store).transcript.reason).toBe(reason);
      const second = await owningRunner.start({ id: "second", instruction: "Try again" });
      expect(second.outcome).toBe("options");
      expect(count).toBe(3);
    },
  );

  it("interrupts an intent/commit/result crash gap on restart without resuming or losing the commit", async () => {
    mkdirSync(dataDir(), { recursive: true });
    const dir = mkdtempSync(join(dataDir(), "server-crash-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "test.sqlite");
    const fixture = await setup(brief, path);
    fixture.store.createRun({
      id: "crashed",
      projectId: "p",
      ref: "option",
      status: "queued",
      outcome: null,
      instruction: "Try",
      revisionId: fixture.initial.revisionId,
      briefVersion: 1,
      baselineRevisionId: fixture.initial.revisionId,
      strategySeed: null,
      budget: DEFAULT_RUN_BUDGET,
      retryCount: 0,
    });
    fixture.store.updateRun("crashed", { status: "running" });
    const params = {
      projectId: "p",
      ref: "option",
      baseRevision: fixture.initial.revisionId,
      requestId: runRequestId("crashed", "edit"),
      body: { ops: [tag], briefVersion: 1, baselineRevisionId: fixture.initial.revisionId },
    };
    fixture.store.saveRunTurn({
      runId: "crashed",
      turn: 0,
      transcript: { kind: "tool_intent", params },
      result: null,
      spend: {},
    });
    const apply = tools.find((tool) => tool.name === "apply_changes");
    if (!apply) throw new Error("missing tool");
    const result = await apply.execute(params, { ...fixture.context, runId: "crashed" });
    expect(result.data).toMatchObject({ ok: true });
    const revisionId = fixture.store.readState("p", "option")?.revisionId;
    const reloaded = openStore(path);
    cleanups.push(() => reloaded.close());
    const driver = vi.fn(script([]));
    runner(
      { ...fixture, store: reloaded, context: { ...fixture.context, store: reloaded } },
      driver,
    );
    expect(reloaded.readRun("crashed")).toMatchObject({
      status: "interrupted",
      revisionId,
      evaluation: null,
    });
    expect(reloaded.readRunTurns("crashed")).toHaveLength(1);
    expect(reloaded.readState("p", "option")?.revisionId).toBe(revisionId);
    expect(driver).not.toHaveBeenCalled();
    expect(fixture.store.readState("p", "main")?.revisionId).toBe(fixture.initial.revisionId);
  });

  it("uses only independent mandatory disjoint area evidence, with a conservative envelope boundary", async () => {
    const impossible: Brief = {
      schemaVersion: 2,
      rooms: [{ id: "large", program: "office", quantity: 2, hard: true }],
      constraints: [
        {
          kind: "min_area",
          target: { kind: "program", program: "office" },
          areaM2: 3_000_000,
          hard: true,
        },
      ],
    };
    expect(areaEnvelopeEvidence(impossible)).toMatchObject({
      requiredMinimumMm2: 5_999_999_999_998,
      maximumAreaMm2: 4_000_000_000_000,
    });
    expect(
      areaEnvelopeEvidence({ ...impossible, rooms: [{ ...impossible.rooms[0], hard: false }] }),
    ).toBeNull();
    expect(
      areaEnvelopeEvidence({
        ...impossible,
        constraints: [{ ...impossible.constraints[0], areaM2: 2_000_000 }],
      }),
    ).toBeNull();
    const fixture = await setup(impossible);
    const driver = vi.fn(script([]));
    const run = await runner(fixture, driver).start({ id: "run", instruction: "Try" });
    expect(run).toMatchObject({
      status: "done",
      outcome: "infeasible",
      revisionId: fixture.initial.revisionId,
      evaluation: {
        evaluatorVersion: "area-envelope/1",
        result: { kind: "global_coordinate_area_envelope" },
      },
    });
    expect(driver).not.toHaveBeenCalled();
  });
});
