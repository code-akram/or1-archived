import * as core from "@or1/core";
import { type Brief, checkModel, emptyModel, type Model, type Op } from "@or1/core";
import { openStore, type RefState, type Store } from "@or1/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AcceptOptionInput,
  type AcceptOptionResult,
  acceptOption,
  type ReviewOptionResult,
  reviewOption,
  type ToolContext,
  tools,
} from "../src/index.ts";

const brief: Brief = {
  schemaVersion: 2,
  rooms: [{ id: "bed", program: "bedroom", quantity: 1, hard: true, targetAreaM2: 12 }],
  constraints: [],
};

/** Synthetic reachable room; unused suffixes below 10 represent retired identities. */
function fixture(): Model {
  return {
    ...emptyModel(),
    walls: [
      {
        id: "W1",
        start: { x: 0, y: 0 },
        end: { x: 4000, y: 0 },
        thickness: 200,
        locked: false,
        structural: false,
      },
      {
        id: "W2",
        start: { x: 4000, y: 0 },
        end: { x: 4000, y: 3000 },
        thickness: 200,
        locked: false,
        structural: false,
      },
      {
        id: "W3",
        start: { x: 4000, y: 3000 },
        end: { x: 0, y: 3000 },
        thickness: 200,
        locked: false,
        structural: false,
      },
      {
        id: "W4",
        start: { x: 0, y: 3000 },
        end: { x: 0, y: 0 },
        thickness: 200,
        locked: false,
        structural: false,
      },
    ],
    openings: [
      {
        id: "O1",
        kind: "door",
        wall: "W1",
        offset: 1200,
        width: 1000,
        locked: false,
        hinge: "start",
        swing: "left",
        entrance: true,
      },
    ],
    spaces: [{ id: "S8", anchor: { x: 2000, y: 1500 }, program: "bedroom", requirementId: "bed" }],
    next: { wall: 10, opening: 10, space: 10 },
  };
}

let store: Store;
let ctx: ToolContext;
async function call(name: string, params: unknown, context = ctx): Promise<unknown> {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error("Missing tool");
  return (await tool.execute(params, context)).data;
}
function state(ref = "main"): RefState {
  const value = store.readState("p", ref);
  if (!value) throw new Error("Missing state");
  return value;
}
async function setup(model = fixture(), body = brief) {
  expect(
    await call("create_project", {
      projectId: "p",
      ref: "main",
      baseRevision: null,
      requestId: "create",
      body: { model, brief: body },
    }),
  ).toMatchObject({ ok: true });
  expect(
    await call("fork_ref", {
      projectId: "p",
      ref: "option",
      baseRevision: state().revisionId,
      requestId: "fork",
      body: { sourceRef: "main" },
    }),
  ).toMatchObject({ ok: true });
}
async function change(ref: string, requestId: string, ops: Op[] = []) {
  const s = state(ref);
  return call("apply_changes", {
    projectId: "p",
    ref,
    baseRevision: s.revisionId,
    requestId,
    body: {
      ops,
      briefVersion: s.brief.version,
      baselineRevisionId: s.forkBase?.revisionId ?? null,
    },
  });
}
function acceptance(requestId = "accept", sourceRef = "option"): AcceptOptionInput {
  const main = state();
  const source = state(sourceRef);
  return {
    projectId: "p",
    ref: "main",
    baseRevision: main.revisionId,
    requestId,
    body: {
      sourceRef,
      sourceRevisionId: source.revisionId,
      briefVersion: main.brief.version,
      baselineRevisionId: source.forkBase?.revisionId ?? main.revisionId,
      evaluatorVersion: "2.0",
    },
  };
}
async function review(ref = "option"): Promise<ReviewOptionResult> {
  return (await reviewOption.execute({ projectId: "p", ref }, ctx)).data as ReviewOptionResult;
}
async function accept(params = acceptance()): Promise<AcceptOptionResult> {
  return (await acceptOption.execute(params, ctx)).data as AcceptOptionResult;
}
/** Seed an invalid persisted option via the bounded store evaluator, never direct SQL or repair. */
function persistOption(model: unknown) {
  const source = state("option");
  expect(
    store.execute(
      {
        type: "apply_changes",
        projectId: "p",
        ref: "option",
        baseRevision: source.revisionId,
        requestId: "fixture",
        body: {},
      },
      { role: "owner", namespace: "fixture" },
      () => ({ ok: true, model, effects: [] }),
    ),
  ).toMatchObject({ ok: true });
}

beforeEach(() => {
  store = openStore(":memory:");
  ctx = { role: "owner", namespace: "owner", store };
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

describe("review and acceptance authorization", () => {
  it("rejects nonowners, every scope, and run bindings before any store access, including retries", async () => {
    await setup();
    const params = acceptance();
    expect(await accept(params)).toMatchObject({ ok: true });
    const execute = vi.spyOn(store, "execute");
    const read = vi.spyOn(store, "readReview");
    for (const [extra, code] of [
      [{ role: "agent" }, "forbidden"],
      [{ role: "external" }, "forbidden"],
      [{ scope: { projectId: "p", ref: "main" } }, "forbidden"],
      [{ scope: { projectId: "p", ref: "option" } }, "forbidden"],
      [{ runId: "completed-run" }, "invalid_run_binding"],
    ] as const) {
      const context = { ...ctx, ...extra };
      expect(await call("review_option", { projectId: "p", ref: "option" }, context)).toMatchObject(
        { ok: false, code },
      );
      expect(await call("accept_option", params, context)).toMatchObject({ ok: false, code });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["owner", "external"] as const)(
    "restricts project review capability for %s across every registry tool before store access",
    async (role) => {
      await setup();
      const accepted = acceptance();
      expect(await accept(accepted)).toMatchObject({ ok: true });
      const envelope = {
        projectId: "p",
        ref: "main",
        baseRevision: state().revisionId,
        requestId: "restricted",
      };
      const inputs: Record<string, unknown> = {
        inspect_project: { projectId: "p" },
        scorecard: { projectId: "p", ref: "option" },
        apply_changes: {
          ...envelope,
          body: { ops: [], briefVersion: 1, baselineRevisionId: null },
        },
        create_project: {
          ...envelope,
          baseRevision: null,
          body: { model: fixture(), brief },
        },
        fork_ref: { ...envelope, ref: "new-option", body: { sourceRef: "main" } },
        set_brief: { ...envelope, baseBriefVersion: 1, body: { brief } },
        review_option: { projectId: "p", ref: "option" },
        accept_option: accepted,
      };
      const storeAccess = vi.fn((): Store => {
        throw new Error("Restricted calls must not access the store");
      });
      const context: ToolContext = {
        role,
        namespace: "cloud",
        reviewProjectId: "p",
        get store() {
          return storeAccess();
        },
      };
      for (const tool of tools) {
        expect(inputs).toHaveProperty(tool.name);
        if (tool.name === "review_option") {
          expect(
            await call(tool.name, inputs[tool.name], { ...ctx, role, reviewProjectId: "p" }),
          ).toMatchObject({ ok: true });
        } else {
          expect(await call(tool.name, inputs[tool.name], context)).toMatchObject({
            ok: false,
            code: "forbidden",
          });
        }
      }
      expect(storeAccess).not.toHaveBeenCalled();
    },
  );

  it("rejects wrong-project, agent, scope and run-bound review capabilities before store access", async () => {
    const storeAccess = vi.fn((): Store => {
      throw new Error("Invalid capabilities must not access the store");
    });
    for (const role of ["owner", "external"] as const) {
      for (const [extra, code] of [
        [{ reviewProjectId: "other" }, "forbidden"],
        [{ role: "agent" }, "forbidden"],
        [{ scope: { projectId: "p", ref: "option" } }, "forbidden"],
        [{ scope: { projectId: "p", ref: "main" } }, "forbidden"],
        [{ runId: "run" }, "invalid_run_binding"],
        [{ runId: "" }, "invalid_run_binding"],
      ] as const) {
        const context: ToolContext = {
          role,
          namespace: "cloud",
          reviewProjectId: "p",
          ...extra,
          get store() {
            return storeAccess();
          },
        };
        expect(
          await call("review_option", { projectId: "p", ref: "option" }, context),
        ).toMatchObject({ ok: false, code });
      }
    }
    expect(storeAccess).not.toHaveBeenCalled();
  });

  it("validates bounded project capability context and never accepts it from parameters", async () => {
    const storeAccess = vi.fn((): Store => {
      throw new Error("Malformed capabilities must not access the store");
    });
    for (const reviewProjectId of [
      null,
      false,
      1,
      {},
      [],
      "",
      "p".repeat(129),
      "p\u0000",
      "p\u001f",
    ]) {
      for (const role of ["owner", "external"] as const) {
        const context = {
          role,
          namespace: "cloud",
          reviewProjectId,
          get store() {
            return storeAccess();
          },
        } as unknown as ToolContext;
        expect(
          await call("review_option", { projectId: "p", ref: "option" }, context),
        ).toMatchObject({ ok: false, code: "unauthorized" });
      }
    }
    expect(storeAccess).not.toHaveBeenCalled();
    const read = vi
      .spyOn(store, "readReview")
      .mockReturnValue({ ok: false, code: "ref_not_found" });
    for (const projectId of ["p", "p".repeat(128), "p\u0020"]) {
      expect(
        await call(
          "review_option",
          { projectId, ref: "option" },
          {
            ...ctx,
            role: "external",
            reviewProjectId: projectId,
          },
        ),
      ).toMatchObject({ ok: false, code: "ref_not_found" });
      expect(read).toHaveBeenLastCalledWith(projectId, "option");
    }
    read.mockClear();
    expect(
      await call(
        "review_option",
        {
          projectId: "p",
          ref: "option",
          reviewProjectId: "p",
        },
        { ...ctx, role: "external" },
      ),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await call(
        "review_option",
        { projectId: "p", ref: "option" },
        {
          ...ctx,
          role: "external",
        },
      ),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns real viewer review and option eligibility for any project candidate without granting acceptance", async () => {
    await setup();
    await call("fork_ref", {
      projectId: "p",
      ref: "unlisted-option",
      baseRevision: state().revisionId,
      requestId: "unlisted-fork",
      body: { sourceRef: "main" },
    });
    await change("unlisted-option", "viewer-label", [
      { op: "tag_space", space: "S8", label: "Unlisted candidate" },
    ]);
    const viewer: ToolContext = {
      ...ctx,
      role: "external",
      namespace: "viewer",
      reviewProjectId: "p",
    };
    const mainBefore = state();
    const candidate = state("unlisted-option");
    const reviewed = await call("review_option", { projectId: "p", ref: candidate.ref }, viewer);
    expect(reviewed).toEqual(await review(candidate.ref));
    expect(reviewed).toMatchObject({
      ok: true,
      projectId: "p",
      brief,
      eligibility: { allowed: true },
      main: { revisionId: mainBefore.revisionId, model: mainBefore.model },
      option: {
        revisionId: candidate.revisionId,
        model: candidate.model,
        derived: { spaces: [{ id: "S8", requirementId: "bed", netArea: 10_640_000 }] },
        scorecard: { valid: true, certification: "none" },
      },
    });
    expect(JSON.parse(JSON.stringify(reviewed))).toEqual(reviewed);
    expect(
      await call("accept_option", acceptance("viewer-accept", candidate.ref), viewer),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(state()).toEqual(mainBefore);
    await change("main", "advance-main");
    expect(
      await call("review_option", { projectId: "p", ref: candidate.ref }, viewer),
    ).toMatchObject({ ok: true, eligibility: { allowed: false, code: "stale_baseline" } });
  });

  it("rejects missing/nonmain refs, invalid bounds, nullable pins, and spoofed authority/evidence", async () => {
    await setup();
    const read = vi.spyOn(store, "readReview");
    const execute = vi.spyOn(store, "execute");
    for (const input of [
      { projectId: "p" },
      { projectId: "p", ref: "main" },
      { projectId: "p", ref: "" },
      { projectId: "p", ref: "option", role: "owner" },
    ])
      expect(await call("review_option", input)).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
    const params = acceptance();
    for (const input of [
      { ...params, ref: "option" },
      { ...params, baseRevision: null },
      { ...params, body: { ...params.body, sourceRef: "main" } },
      { ...params, body: { ...params.body, baselineRevisionId: null } },
      { ...params, body: { ...params.body, briefVersion: -1 } },
      { ...params, body: { ...params.body, briefVersion: Number.MAX_SAFE_INTEGER + 1 } },
      { ...params, body: { ...params.body, evaluatorVersion: "v".repeat(129) } },
      { ...params, requestId: "bad\u0000" },
      ...["scorecard", "score", "actor", "model", "role", "runId"].map((key) => ({
        ...params,
        body: { ...params.body, [key]: {} },
      })),
      { ...params, actor: { role: "owner" } },
    ])
      expect(await call("accept_option", input)).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
    expect(read).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps main apply_changes owner-only before replay while option edits remain available", async () => {
    await setup();
    const main = state();
    const params = {
      projectId: "p",
      ref: "main",
      baseRevision: main.revisionId,
      requestId: "main-owner",
      body: { ops: [], briefVersion: 1, baselineRevisionId: null },
    };
    expect(await call("apply_changes", params)).toMatchObject({ ok: true });
    for (const role of ["agent", "external"] as const) {
      expect(await call("apply_changes", params, { ...ctx, role })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      const option = state("option");
      expect(
        await call(
          "apply_changes",
          {
            ...params,
            ref: "option",
            baseRevision: option.revisionId,
            requestId: `option-${role}`,
            body: { ...params.body, baselineRevisionId: option.forkBase?.revisionId },
          },
          { ...ctx, role },
        ),
      ).toMatchObject({ ok: true });
    }
  });
});

describe("coherent review and fresh acceptance", () => {
  it("returns actual serializable geometry, requirement IDs and noncertifying scores; accepts a manual snapshot exactly", async () => {
    await setup();
    expect(
      await change("option", "label", [{ op: "tag_space", space: "S8", label: "Manual option" }]),
    ).toMatchObject({ ok: true });
    const mainBefore = state();
    const sourceBefore = state("option");
    const reviewed = await review();
    expect(reviewed).toMatchObject({
      ok: true,
      projectId: "p",
      ref: "option",
      briefVersion: 1,
      baselineRevisionId: mainBefore.revisionId,
      brief,
      eligibility: { allowed: true },
      main: {
        revisionId: mainBefore.revisionId,
        scorecard: { valid: true, certification: "none" },
      },
      option: {
        revisionId: sourceBefore.revisionId,
        derived: {
          spaces: [{ id: "S8", requirementId: "bed", netArea: 10_640_000 }],
          openings: [{ id: "O1" }],
          problems: [],
        },
        scorecard: {
          valid: true,
          certification: "none",
          requirements: [{ id: "bed", quantity: 1, present: 1, spaces: ["S8"] }],
        },
      },
    });
    if (!reviewed.ok) throw new Error("Expected review");
    expect(
      reviewed.option.scorecard.scores.find((entry) => entry.score === "area_fit")?.value,
    ).toBeCloseTo(1 - (12 - 10.64) / 12);
    expect(Object.keys(reviewed.option.derived).sort()).toEqual([
      "adjacencies",
      "openings",
      "problems",
      "slab",
      "spaces",
    ]);
    expect(JSON.parse(JSON.stringify(reviewed))).toEqual(reviewed);
    const ledger = vi.spyOn(store, "readRun").mockImplementation(() => {
      throw new Error("No run evidence is needed");
    });
    const params = acceptance();
    const accepted = await accept(params);
    expect(accepted).toMatchObject({
      ok: true,
      effects: [],
      briefVersion: 1,
      acceptance: {
        ...params.body,
        schemaVersion: 1,
        projectId: "p",
        previousMainRevisionId: mainBefore.revisionId,
        requestId: "accept",
        actor: { role: "owner", namespace: "owner" },
        scorecard: reviewed.option.scorecard,
      },
    });
    expect(ledger).not.toHaveBeenCalled();
    expect(state().model).toEqual(sourceBefore.model);
    expect(state("option")).toEqual(sourceBefore);
    expect(store.readSnapshot("p", mainBefore.revisionId)).toEqual(mainBefore.model);
    expect(state().revisionId).not.toBe(sourceBefore.revisionId);
  });

  it("cannot replace failed core gates with a completed run's claimed success", async () => {
    await setup();
    await change("option", "unassign", [{ op: "tag_space", space: "S8", requirementId: null }]);
    const source = state("option");
    store.createRun({
      id: "done",
      projectId: "p",
      ref: "option",
      status: "queued",
      outcome: null,
      instruction: "Synthetic",
      revisionId: source.revisionId,
      baselineRevisionId: source.forkBase?.revisionId ?? null,
      briefVersion: 1,
      strategySeed: null,
      budget: {},
      retryCount: 0,
    });
    expect(
      store.finalizeRun("done", "options", {
        revisionId: source.revisionId,
        baselineRevisionId: source.forkBase?.revisionId ?? null,
        briefVersion: 1,
        evaluatorVersion: "2.0",
        result: { valid: true },
      }),
    ).toMatchObject({ ok: true });
    expect(store.readRun("done")?.status).toBe("done");
    expect(await review()).toMatchObject({
      ok: true,
      eligibility: { allowed: false, code: "invalid_option" },
    });
    const main = state();
    expect(await accept()).toMatchObject({
      ok: false,
      code: "invalid_option",
      details: expect.arrayContaining([
        expect.objectContaining({
          gate: "required_rooms",
          passed: false,
          failures: [{ detail: "bed (bedroom): 0 of 1 present", subjects: ["bed"] }],
        }),
      ]),
    });
    expect(state()).toEqual(main);
  });

  it("accepts agent-authored options using the same fresh core score", async () => {
    await setup();
    const s = state("option");
    expect(
      await call(
        "apply_changes",
        {
          projectId: "p",
          ref: "option",
          baseRevision: s.revisionId,
          requestId: "agent-option",
          body: {
            ops: [{ op: "tag_space", space: "S8", label: "Agent option" }],
            briefVersion: 1,
            baselineRevisionId: s.forkBase?.revisionId,
          },
        },
        { ...ctx, role: "agent", scope: { projectId: "p", ref: "option" } },
      ),
    ).toMatchObject({ ok: true });
    expect(await accept()).toMatchObject({ ok: true });
    expect((state().model as Model).spaces[0]?.label).toBe("Agent option");
  });

  it("rejects protected owner edits, including host-relative openings", async () => {
    const model = fixture();
    const wall = model.walls[0];
    if (!wall) throw new Error("Missing wall");
    wall.locked = true;
    await setup(model);
    expect(
      await change("option", "opening-owner", [{ op: "update_opening", id: "O1", offset: 1400 }]),
    ).toMatchObject({ ok: true });
    expect(await accept()).toMatchObject({
      ok: false,
      code: "invalid_option",
      details: expect.arrayContaining([
        expect.objectContaining({
          gate: "protected_intact",
          failures: [{ detail: "protected opening O1 was changed or removed", subjects: ["O1"] }],
        }),
      ]),
    });
    expect(await review()).toMatchObject({
      ok: true,
      eligibility: { allowed: false, code: "invalid_option" },
    });
  });

  it("keeps stale options viewable and scores protected geometry against returned main, not historical fork", async () => {
    const model = fixture();
    const wall = model.walls[0];
    if (!wall) throw new Error("Missing wall");
    wall.locked = true;
    await setup(model);
    await change("main", "main-unlock", [{ op: "update_wall", id: "W1", locked: false }]);
    await change("option", "option-change", [{ op: "update_wall", id: "W1", thickness: 300 }]);
    expect(await call("scorecard", { projectId: "p", ref: "option" })).toMatchObject({
      ok: true,
      result: {
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "protected_intact", passed: false }),
        ]),
      },
    });
    expect(await review()).toMatchObject({
      ok: true,
      eligibility: { allowed: false, code: "stale_baseline" },
      option: {
        scorecard: {
          gates: expect.arrayContaining([
            expect.objectContaining({ gate: "protected_intact", passed: true }),
          ]),
        },
      },
    });
    expect(await accept()).toMatchObject({ ok: false, code: "stale_baseline" });
  });

  it("rejects independently stale main, source, brief, baseline and evaluator pins", async () => {
    await setup();
    const params = acceptance();
    for (const [pin, code] of [
      [{ baseRevision: "other" }, "stale_base"],
      [{ body: { ...params.body, sourceRevisionId: "other" } }, "stale_source"],
      [{ body: { ...params.body, briefVersion: 0 } }, "stale_brief"],
      [{ body: { ...params.body, baselineRevisionId: "other" } }, "stale_baseline"],
      [{ body: { ...params.body, evaluatorVersion: "next" } }, "stale_evaluator"],
    ] as const)
      expect(await accept({ ...params, ...pin, requestId: code })).toMatchObject({
        ok: false,
        code,
      });
    expect(state().revisionId).toBe(params.baseRevision);
  });

  it("reports a valid but oversized score as ineligible without writing main", async () => {
    const optional = Array.from({ length: 127 }, (_, index) => ({
      id: `optional_${index}`.padEnd(64, "x"),
      program: `optional_${index}`,
      quantity: 1,
      hard: false,
    }));
    const large: Brief = {
      ...brief,
      rooms: [...brief.rooms, ...optional],
      constraints: Array.from({ length: 256 }, (_, index) => ({
        kind: "daylight",
        target: { kind: "requirement", id: optional[index % optional.length]?.id as string },
        hard: false,
      })),
    };
    await setup(fixture(), large);
    const before = state();
    expect(await review()).toMatchObject({
      ok: true,
      option: { scorecard: { valid: true } },
      eligibility: { allowed: false, code: "score_too_large" },
    });
    expect(await accept()).toMatchObject({ ok: false, code: "score_too_large" });
    expect(state()).toEqual(before);
  });

  it("rejects a source forked from a divergent option rather than current main", async () => {
    await setup();
    await change("option", "diverge", [{ op: "tag_space", space: "S8", label: "Intermediate" }]);
    expect(
      await call("fork_ref", {
        projectId: "p",
        ref: "nested",
        baseRevision: state("option").revisionId,
        requestId: "nested",
        body: { sourceRef: "option" },
      }),
    ).toMatchObject({ ok: true });
    expect(await review("nested")).toMatchObject({
      ok: true,
      eligibility: { allowed: false, code: "stale_baseline" },
    });
    expect(await accept(acceptance("accept-nested", "nested"))).toMatchObject({
      ok: false,
      code: "stale_baseline",
    });
  });

  it("replays the exact receipt after head/brief/evaluator changes without rescoring", async () => {
    await setup();
    const params = acceptance();
    const first = await accept(params);
    expect(first.ok).toBe(true);
    await change("main", "later");
    expect(
      await call("set_brief", {
        projectId: "p",
        ref: "main",
        baseRevision: state().revisionId,
        baseBriefVersion: 1,
        requestId: "brief",
        body: {
          brief: { ...brief, rooms: brief.rooms.map((room) => ({ ...room, targetAreaM2: 15 })) },
        },
      }),
    ).toMatchObject({ ok: true });
    const evaluator = vi.spyOn(core, "scorecard").mockImplementation(() => {
      throw new Error("Evaluator has changed and must not run on replay");
    });
    expect(await accept(params)).toEqual(first);
    expect(evaluator).not.toHaveBeenCalled();
    expect(
      await accept({ ...params, body: { ...params.body, evaluatorVersion: "next" } }),
    ).toMatchObject({ ok: false, code: "request_conflict" });
  });
});

describe("acceptance identity and persisted input integrity", () => {
  it.each(["wall", "opening", "space"] as const)(
    "rejects regressed %s counters without repair",
    async (kind) => {
      await setup();
      const model = structuredClone(state("option").model) as Model;
      model.next[kind] = kind === "wall" ? 5 : kind === "opening" ? 2 : 9;
      expect(checkModel(model)).toEqual([]);
      persistOption(model);
      expect(await review()).toMatchObject({
        ok: true,
        eligibility: { allowed: false, code: "invalid_identity" },
      });
      expect(await accept()).toMatchObject({ ok: false, code: "invalid_identity" });
      expect(state("option").model).toEqual(model);
    },
  );

  it.each(["wall", "opening", "space"] as const)(
    "rejects retired %s ID injection even with unchanged counters",
    async (kind) => {
      await setup();
      const model = structuredClone(state("option").model) as Model;
      if (kind === "wall") {
        const wall = model.walls[3];
        if (!wall) throw new Error("Missing wall");
        wall.id = "W7";
      } else if (kind === "opening") {
        const opening = model.openings[0];
        if (!opening) throw new Error("Missing opening");
        opening.id = "O7";
      } else {
        const space = model.spaces[0];
        if (!space) throw new Error("Missing space");
        space.id = "S3";
      }
      expect(checkModel(model)).toEqual([]);
      persistOption(model);
      expect(await review()).toMatchObject({
        ok: true,
        eligibility: { allowed: false, code: "invalid_identity" },
      });
      expect(await accept()).toMatchObject({ ok: false, code: "invalid_identity" });
    },
  );

  it("accepts newly issued IDs at the main counter boundary and preserves their counters", async () => {
    await setup();
    const model = structuredClone(state("option").model) as Model;
    const opening = model.openings[0];
    if (!opening) throw new Error("Missing opening");
    opening.id = "O10";
    model.next.opening = 11;
    persistOption(model);
    expect(await review()).toMatchObject({ ok: true, eligibility: { allowed: true } });
    expect(await accept()).toMatchObject({ ok: true });
    expect(state().model).toEqual(model);
  });

  it.each([
    ["v1", (model: Model) => ({ ...model, schemaVersion: 1 }), "invalid_input"],
    [
      "bounds",
      (model: Model) => ({ ...model, next: { ...model.next, wall: 1_000_001 } }),
      "limit_exceeded",
    ],
    ["topology", (model: Model) => ({ ...model, spaces: [] }), "invalid_input"],
  ] as const)(
    "rejects persisted %s without migrating or healing",
    async (_label, invalidate, code) => {
      await setup();
      const malformed = invalidate(state("option").model as Model);
      persistOption(malformed);
      const before = state();
      expect(await review()).toMatchObject({ ok: false, code });
      expect(await accept()).toMatchObject({ ok: false, code });
      expect(state()).toEqual(before);
      expect(state("option").model).toEqual(malformed);
    },
  );
});
