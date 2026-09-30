import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type Model as AgentModel,
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { type Brief, type Model, type Op, validateBrief, validateModel } from "@or1/core";
import { dataDir, openStore } from "@or1/store";
import {
  createProject,
  forkRef,
  type ReviewOptionSuccess,
  reviewOption,
  type ToolContext,
} from "@or1/tools";
import { createRunRunner, type RunBudget, TEST_FIT_INSTRUCTION } from "./runs.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
export type EvalFixture = { name: string; shell: Model; brief: Brief };

/** Public fixture input only; live runs never load a witness or its construction operations. */
export function readFixtureJson(path: string): unknown {
  if (statSync(path).size > 262_144) throw new Error("Fixture file exceeds 262144 bytes");
  const bytes = readFileSync(path);
  if (bytes.byteLength > 262_144) throw new Error("Fixture file exceeds 262144 bytes");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function loadFixture(directory: string): EvalFixture {
  const shell = readFixtureJson(join(directory, "shell.json"));
  const brief = readFixtureJson(join(directory, "brief.json"));
  validateModel(shell);
  validateBrief(brief);
  return { name: brief.name ?? "Unnamed fixture", shell, brief };
}

/** A disclosed proof replay, not a real-model quality result or token-usage measurement. */
export function replayWitness(ops: Op[]): { model: AgentModel<Api>; streamFn: StreamFn } {
  const model: AgentModel<"openai-completions"> = {
    id: "witness-replay",
    name: "Deterministic witness replay",
    api: "openai-completions",
    provider: "synthetic",
    baseUrl: "https://invalid.example",
    input: ["text"],
    reasoning: false,
    contextWindow: 100_000,
    maxTokens: 100_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let edited = false;
  const streamFn: StreamFn = () => {
    const content: AssistantMessage["content"] = edited
      ? [{ type: "text", text: "Deterministic witness replay finished." }]
      : [{ type: "toolCall", id: "witness", name: "apply_changes", arguments: { body: { ops } } }];
    const message: AssistantMessage = {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: edited ? "stop" : "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    edited = true;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  return { model, streamFn };
}

/** Creates an isolated private database. No existing project or main is ever overwritten/accepted. */
export async function evaluateFixture(options: {
  fixture: EvalFixture;
  mode: "witness-replay" | "chatgpt-subscription";
  model: AgentModel<Api>;
  streamFn: StreamFn;
  outputRoot?: string;
  budget?: Partial<RunBudget>;
  signal?: AbortSignal;
}) {
  validateModel(options.fixture.shell);
  validateBrief(options.fixture.brief);
  const root = resolve(options.outputRoot ?? join(dataDir(), "eval-runs"));
  // Check the real path too: OR1_DATA_DIR must not redirect private evidence into the checkout.
  const inside = (path: string) => {
    const rel = relative(repository, path);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  };
  if (inside(root)) throw new Error("Evaluation output must be outside the repository");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (inside(realpathSync(root)))
    throw new Error("Evaluation output must be outside the repository");
  const directory = mkdtempSync(join(root, "test-fit-"));
  const database = join(directory, "or1.sqlite");
  const store = openStore(database);
  chmodSync(database, 0o600);
  const id = randomUUID();
  const projectId = `eval-${id}`;
  // Authority comes from the trusted local operator, never model-supplied role or arguments.
  const owner: ToolContext = { store, role: "owner", namespace: `local-eval-owner:${id}` };
  try {
    const created = await createProject.execute(
      {
        projectId,
        ref: "main",
        baseRevision: null,
        requestId: `${id}:create`,
        body: { model: options.fixture.shell, brief: options.fixture.brief },
      },
      owner,
    );
    const initial = store.readState(projectId, "main");
    if (!created.data || !(created.data as { ok: boolean }).ok || !initial)
      throw new Error("Fixture project creation rejected");
    const forked = await forkRef.execute(
      {
        projectId,
        ref: "option",
        baseRevision: initial.revisionId,
        requestId: `${id}:fork`,
        body: { sourceRef: "main" },
      },
      owner,
    );
    if (!forked.data || !(forked.data as { ok: boolean }).ok)
      throw new Error("Fixture option fork rejected");
    const runner = createRunRunner({
      store,
      context: {
        store,
        role: "agent",
        namespace: `local-eval-agent:${id}`,
        scope: { projectId, ref: "option" },
      },
      model: options.model,
      streamFn: options.streamFn,
    });
    const run = await runner.start({
      id,
      instruction:
        `${TEST_FIT_INSTRUCTION} ` +
        (options.mode === "witness-replay"
          ? "This is a disclosed deterministic witness replay, not independent model quality evidence."
          : "No witness solution is supplied."),
      ...(options.budget ? { budget: options.budget } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const result = await reviewOption.execute({ projectId, ref: "option" }, owner);
    const review = result.data as ReviewOptionSuccess;
    if (!review?.ok) throw new Error("Evaluation review rejected");
    if (review.main.revisionId !== initial.revisionId) throw new Error("Evaluation changed main");
    const turns = store.readRunTurns(id);
    // These public fixtures have rectangular shells. Core gate validity alone does not prohibit
    // an otherwise harmless stray wall outside that shell, so report this benchmark check separately.
    const points = options.fixture.shell.walls.flatMap((wall) => [wall.start, wall.end]);
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const withinShellBounds = review.option.model.walls.every((wall) =>
      [wall.start, wall.end].every(
        (point) => point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY,
      ),
    );
    const summary = {
      schemaVersion: 1,
      mode: options.mode,
      fixture: options.fixture.name,
      model: { provider: options.model.provider, id: options.model.id },
      projectId,
      ref: "option",
      database,
      run,
      accounting: turns.at(-1)?.spend,
      settlement: turns.at(-1)?.transcript,
      mainUnchanged: true,
      acceptancePerformed: false,
      witnessAvailableToModel: options.mode === "witness-replay",
      withinShellBounds,
      passed: run.outcome === "options" && review.option.scorecard.valid && withinShellBounds,
    };
    for (const [name, value] of [
      ["summary", summary],
      ["review", review],
      ["turns", turns],
    ] as const)
      writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
      });
    return { directory, summary, review };
  } finally {
    store.close();
  }
}
