import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Rejection, Store } from "@or1/store";
import {
  forkRef,
  type GenerateResult,
  type Strategy,
  type StudioStatus,
  type ToolContext,
} from "@or1/tools";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { createRunRunner, type RunBudget, TEST_FIT_INSTRUCTION } from "./runs.ts";

/**
 * Parallel agents cannot see each other, so distinct directions are what make their options
 * genuinely different rather than near-duplicates.
 */
export const STRATEGIES: readonly Strategy[] = [
  {
    id: "spine",
    label: "Linear spine",
    direction:
      "Run one straight hall or corridor from the entrance door deep into the plan and line the rooms up along it.",
  },
  {
    id: "hub",
    label: "Compact hub",
    direction:
      "Keep circulation minimal: a small hall just inside the entrance opens directly into every room. Give the saved area to the rooms.",
  },
  {
    id: "daylight",
    label: "Daylight first",
    direction:
      "Allocate the windowed exterior walls first: each habitable room gets its own window wall with as much frontage as possible; fit the hall and service rooms into the darker interior.",
  },
  {
    id: "zones",
    label: "Social / quiet zones",
    direction:
      "Divide the plan into a social zone next to the entrance and a quiet zone (bedrooms, study) at the far end, with the hall between them.",
  },
  {
    id: "contrarian",
    label: "Other axis",
    direction:
      "Deliberately split the plan along the axis you would not choose first (for example the long axis instead of the short one), while still meeting every hard gate.",
  },
];

const identifier = Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001f]+$" });
export const GenerateSchema = Type.Object(
  {
    projectId: identifier,
    count: Type.Integer({ minimum: 1, maximum: 8 }),
    /** Optional owner direction shared by every agent in this batch. */
    note: Type.Optional(Type.String({ maxLength: 2000 })),
    /** Strategy IDs to use in order; defaults rotate through STRATEGIES. */
    strategies: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 8 })),
  },
  { additionalProperties: false },
);
export const CancelSchema = Type.Object({ runId: identifier }, { additionalProperties: false });

/**
 * Owns every agent run on one store: recovers unfinished runs once, then starts scoped runners in
 * parallel, one per new option ref. Authority is the trusted owner context; agents only ever get a
 * credential scoped to their own option.
 */
export function createStudio(options: {
  store: Store;
  owner: ToolContext;
  agent?: { model: Model<Api>; streamFn: StreamFn };
  budget?: Partial<RunBudget>;
}) {
  const { store, owner, agent } = options;
  if (owner.role !== "owner" || owner.store !== store || !owner.namespace || owner.scope)
    throw new Error("Studio requires an unscoped owner context on its store");
  store.interruptRunningRuns();
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** Resolves when every run started so far has settled. */
  const settled = async () => {
    await Promise.all([...active.values()].map((run) => run.done));
  };

  return {
    status(): StudioStatus {
      return {
        ok: true,
        agent: agent
          ? { provider: agent.model.provider, id: agent.model.id, name: agent.model.name }
          : null,
        activeRuns: [...active.keys()],
        strategies: STRATEGIES,
      };
    },

    /** Forks `count` new option refs from current main and starts one agent on each. */
    async generate(input: unknown): Promise<GenerateResult> {
      if (!Value.Check(GenerateSchema, input)) return { ok: false, code: "invalid_input" };
      const params: Static<typeof GenerateSchema> = input;
      if (!agent) return { ok: false, code: "agent_unavailable" };
      const main = store.readState(params.projectId, "main");
      if (!main) return { ok: false, code: "project_not_found" };
      const chosen = params.strategies?.map((id) => STRATEGIES.find((s) => s.id === id));
      if (chosen?.some((strategy) => !strategy)) return { ok: false, code: "unknown_strategy" };
      // Later batches continue the rotation so repeated generation keeps exploring.
      const offset = store.listRuns(params.projectId).length;
      const taken = new Set(store.listRefs(params.projectId).map((ref) => ref.ref));
      const batch = randomUUID();
      const runs: { ref: string; runId: string; strategy: Strategy }[] = [];
      let suffix = 1;
      for (let index = 0; index < params.count; index++) {
        while (taken.has(`option-${suffix}`)) suffix++;
        const ref = `option-${suffix}`;
        taken.add(ref);
        const strategy =
          chosen?.[index % chosen.length] ??
          (STRATEGIES[(offset + index) % STRATEGIES.length] as Strategy);
        const forked = await forkRef.execute(
          {
            projectId: params.projectId,
            ref,
            baseRevision: main.revisionId,
            requestId: `studio:${batch}:${ref}`,
            body: { sourceRef: "main" },
          },
          owner,
        );
        const fork = forked.data as { ok: boolean } | Rejection;
        if (!fork.ok) return { ...(fork as Rejection), ...(runs.length ? { details: runs } : {}) };
        const runner = createRunRunner({
          store,
          context: {
            role: "agent",
            store,
            namespace: `studio-agent:${params.projectId}:${ref}`,
            scope: { projectId: params.projectId, ref },
          },
          model: agent.model,
          streamFn: agent.streamFn,
          recover: false,
        });
        const runId = randomUUID();
        const controller = new AbortController();
        const instruction =
          `${TEST_FIT_INSTRUCTION} Design direction for this option (${strategy.label}): ${strategy.direction}` +
          (params.note?.trim() ? ` Owner note: ${params.note.trim()}` : "");
        // start() creates the run record synchronously before its first await.
        const started = runner.start({
          id: runId,
          instruction,
          strategySeed: strategy,
          signal: controller.signal,
          ...(options.budget ? { budget: options.budget } : {}),
        });
        if (!store.readRun(runId)) {
          await started.catch(() => undefined);
          return { ok: false, code: "run_start_failed", ...(runs.length ? { details: runs } : {}) };
        }
        const done = started
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => active.delete(runId));
        active.set(runId, { controller, done });
        runs.push({ ref, runId, strategy });
      }
      return { ok: true, runs };
    },

    cancel(input: unknown): { ok: true; cancelled: boolean } | Rejection {
      if (!Value.Check(CancelSchema, input)) return { ok: false, code: "invalid_input" };
      const run = active.get(input.runId);
      run?.controller.abort();
      return { ok: true, cancelled: Boolean(run) };
    },

    settled,

    async close(): Promise<void> {
      for (const run of active.values()) run.controller.abort();
      await settled();
    },
  };
}

export type Studio = ReturnType<typeof createStudio>;
