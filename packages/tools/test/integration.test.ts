import { type Brief, checkModel, emptyModel, type Model, type Op } from "@or1/core";
import { openStore, type Store } from "@or1/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOOL_INPUT_BYTES, type ToolContext, tools } from "../src/index.ts";

const emptyBrief: Brief = { schemaVersion: 2, rooms: [], constraints: [] };
const brief: Brief = {
  schemaVersion: 2,
  rooms: [
    { id: "small", program: "bedroom", quantity: 1, hard: true, targetAreaM2: 9 },
    { id: "large", program: "bedroom", quantity: 1, hard: true, targetAreaM2: 18 },
  ],
  constraints: [
    { kind: "min_area", target: { kind: "requirement", id: "large" }, areaM2: 15, hard: true },
  ],
};

/** One synthetic 4m × 3m enclosure, with no pre-derived space records. */
function enclosure(): Model {
  const corners = [
    { x: 0, y: 0 },
    { x: 4000, y: 0 },
    { x: 4000, y: 3000 },
    { x: 0, y: 3000 },
  ];
  return {
    ...emptyModel(),
    walls: corners.map((start, i) => ({
      id: `W${i + 1}` as `W${number}`,
      start,
      end: corners[(i + 1) % 4] as { x: number; y: number },
      thickness: 200,
      locked: false,
      structural: false,
    })),
    next: { wall: 5, opening: 1, space: 8 },
  };
}

let store: Store;
let ctx: ToolContext;
async function call(name: string, params: unknown, context = ctx) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown test tool ${name}`);
  const response = await tool.execute(params, context);
  expect(typeof response.text).toBe("string");
  return response.data;
}
function state(ref = "main") {
  const value = store.readState("p", ref);
  if (!value) throw new Error("Missing fixture ref");
  return value;
}
function create(model = emptyModel(), body = emptyBrief) {
  return {
    projectId: "p",
    ref: "main",
    baseRevision: null,
    requestId: "create",
    body: { model, brief: body },
  };
}
function change(requestId: string, ops: Op[] = [], ref = "main") {
  const current = state(ref);
  return {
    projectId: "p",
    ref,
    baseRevision: current.revisionId,
    requestId,
    body: {
      ops,
      briefVersion: current.brief.version,
      baselineRevisionId: current.forkBase?.revisionId ?? null,
    },
  };
}
function edit(requestId: string, body: Brief) {
  const current = state();
  return {
    projectId: "p",
    ref: "main",
    baseRevision: current.revisionId,
    requestId,
    baseBriefVersion: current.brief.version,
    body: { brief: body },
  };
}
async function fork(ref = "option") {
  return call("fork_ref", {
    projectId: "p",
    ref,
    baseRevision: state().revisionId,
    requestId: `fork-${ref}`,
    body: { sourceRef: "main" },
  });
}

beforeEach(() => {
  store = openStore(":memory:");
  ctx = { role: "owner", namespace: "credential", store };
});
afterEach(() => store.close());

describe("registry authorization and direct validation", () => {
  it("fails closed without credentials/store and validates direct execute calls", async () => {
    expect(await call("create_project", create(), { role: "owner" })).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    expect(await call("inspect_project", { projectId: "p" }, { role: "external" })).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    expect(
      await call("create_project", create(), { role: "owner", namespace: "valid" }),
    ).toMatchObject({ ok: false, code: "store_unavailable" });
    expect(await call("create_project", { ...create(), namespace: "spoof" })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(store.readState("p", "main")).toBeNull();
  });

  it("checks role and trusted scope before replay, including default read refs", async () => {
    const params = create();
    expect(await call("create_project", params)).toMatchObject({ ok: true });
    expect(await call("create_project", params, { ...ctx, role: "agent" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    for (const scope of [
      { projectId: "other", ref: "main" },
      { projectId: "p", ref: "option" },
    ]) {
      expect(await call("create_project", params, { ...ctx, scope })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await call("inspect_project", { projectId: "p" }, { ...ctx, scope })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    }
    expect(
      await call(
        "inspect_project",
        { projectId: "p" },
        { ...ctx, scope: { projectId: "p", ref: "main" } },
      ),
    ).toMatchObject({ ok: true });
    await fork();
    const applied = change("role-test", [], "option");
    expect(await call("apply_changes", applied, { ...ctx, role: "agent" })).toMatchObject({
      ok: true,
    });
    expect(await call("apply_changes", applied, { ...ctx, role: "external" })).toMatchObject({
      ok: false,
      code: "request_conflict",
    });
  });

  it("returns structured finite JSON, depth, byte and numeric/resource rejections", async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = {};
    for (let i = 0; i < 1000; i++) deep = { deep };
    for (const input of [NaN, Infinity, undefined, cycle])
      expect(await call("inspect_project", { projectId: "p", extra: input })).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
    for (const input of [
      deep,
      "x".repeat(MAX_TOOL_INPUT_BYTES),
      "😀".repeat(MAX_TOOL_INPUT_BYTES / 3),
    ])
      expect(await call("inspect_project", { projectId: "p", extra: input })).toMatchObject({
        ok: false,
        code: "limit_exceeded",
      });
    const bad = enclosure();
    bad.next.wall = Number.MAX_SAFE_INTEGER;
    expect(await call("create_project", create(bad))).toMatchObject({
      ok: false,
      code: "limit_exceeded",
    });
    await call("create_project", { ...create(), requestId: "good" });
    const oversized = Array.from({ length: 257 }, (): Op => ({ op: "tag_space", space: "S1" }));
    expect(await call("apply_changes", change("oversized", oversized))).toMatchObject({
      ok: false,
      code: "limit_exceeded",
    });
    expect(
      await call(
        "apply_changes",
        change("numeric", [
          { op: "add_wall", start: { x: 0, y: 0 }, end: { x: 1_000_001, y: 0 }, thickness: 200 },
        ]),
      ),
    ).toMatchObject({ ok: false, code: "limit_exceeded" });
  });

  it("passes exact trusted runId and never accepts it from parameters", async () => {
    const execute = vi
      .spyOn(store, "execute")
      .mockReturnValue({ ok: false, code: "test_rejection" });
    const context = { ...ctx, runId: "trusted-run" };
    await call("create_project", create(), context);
    expect(execute.mock.calls[0]?.[1]).toEqual({
      role: "owner",
      namespace: "credential",
      runId: "trusted-run",
    });
    expect(
      await call("create_project", { ...create(), runId: "untrusted" }, context),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("metadata validation and model identity", () => {
  it("derives missing spaces using fresh counters and replays canonical-key retries", async () => {
    const params = create(enclosure(), brief);
    const before = JSON.stringify(params);
    const first = await call("create_project", params);
    expect(first).toMatchObject({ ok: true, briefVersion: 1 });
    expect(JSON.stringify(params)).toBe(before);
    const persisted = state().model as Model;
    expect(persisted.spaces).toEqual([{ id: "S8", anchor: expect.any(Object) }]);
    expect(persisted.next.space).toBe(9);
    expect(checkModel(persisted)).toEqual([]);
    await call("apply_changes", change("advance"));
    expect(
      await call("create_project", {
        body: params.body,
        requestId: params.requestId,
        baseRevision: params.baseRevision,
        ref: params.ref,
        projectId: params.projectId,
      }),
    ).toEqual(first);
    expect(
      await call("create_project", { ...params, body: { ...params.body, brief: emptyBrief } }),
    ).toMatchObject({ ok: false, code: "request_conflict" });
  });

  it("preserves supplied identities/tags/history and rejects orphan or duplicate space repair", async () => {
    const original = enclosure();
    original.spaces = [
      {
        id: "S3",
        anchor: { x: 1000, y: 1000 },
        program: "bedroom",
        requirementId: "small",
        label: "Keep",
      },
    ];
    const invalid = structuredClone(original);
    invalid.spaces[0] = {
      ...(invalid.spaces[0] as Model["spaces"][number]),
      anchor: { x: -1000, y: -1000 },
    };
    expect(await call("create_project", create(invalid, brief))).toMatchObject({
      ok: false,
      code: "invalid_geometry",
    });
    expect(store.readBriefs("p")).toEqual([]);
    const duplicate = structuredClone(original);
    duplicate.spaces.push({ id: "S4", anchor: { x: 2000, y: 2000 } });
    expect(
      await call("create_project", { ...create(duplicate, brief), requestId: "duplicate" }),
    ).toMatchObject({ ok: false, code: "invalid_geometry" });
    expect(
      await call("create_project", { ...create(original, brief), requestId: "valid" }),
    ).toMatchObject({ ok: true });
    expect((state().model as Model).spaces).toMatchObject([
      { id: "S3", label: "Keep", program: "bedroom", requirementId: "small" },
    ]);
    expect((state().model as Model).next).toEqual(original.next);
  });

  it("allows empty/incomplete options but never infers v1 migration", async () => {
    expect(await call("create_project", create(emptyModel(), brief))).toMatchObject({ ok: true });
    expect(await fork()).toMatchObject({ ok: true });
    expect(await call("scorecard", { projectId: "p", ref: "option" })).toMatchObject({
      ok: true,
      result: {
        valid: false,
        requirements: [
          { id: "small", present: 0 },
          { id: "large", present: 0 },
        ],
      },
    });
    expect(
      await call("create_project", {
        ...create(),
        projectId: "legacy",
        body: {
          model: { ...emptyModel(), schemaVersion: 1 },
          brief: {
            schemaVersion: 1,
            rooms: [
              { program: "bedroom", hard: true },
              { program: "bedroom", hard: false },
            ],
            constraints: [],
          },
        },
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(store.readState("legacy", "main")).toBeNull();
  });

  it("requires main creation, rejects fork to main, and keeps metadata owner-only", async () => {
    expect(await call("create_project", { ...create(), ref: "option" })).toMatchObject({
      ok: false,
      code: "invalid_ref",
    });
    await call("create_project", { ...create(), requestId: "main" });
    expect(await fork("main")).toMatchObject({ ok: false });
    for (const role of ["agent", "external"] as const) {
      expect(await call("set_brief", edit(`brief-${role}`, brief), { ...ctx, role })).toMatchObject(
        { ok: false, code: "forbidden" },
      );
      expect(
        await call(
          "fork_ref",
          {
            projectId: "p",
            ref: role,
            baseRevision: state().revisionId,
            requestId: role,
            body: { sourceRef: "main" },
          },
          { ...ctx, role },
        ),
      ).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("validates semantic duplicates and full retired-ID lineage inside the transaction", async () => {
    await call("create_project", create(emptyModel(), brief));
    const readHistory = vi.spyOn(store, "readBriefs").mockImplementation(() => {
      expect(store.db.isTransaction).toBe(true);
      return store.db
        .prepare("SELECT version, body FROM briefs WHERE project_id = ? ORDER BY version")
        .all("p")
        .map((row) => ({
          version: Number(row.version),
          body: JSON.parse(String(row.body)) as unknown,
        }));
    });
    const edited = {
      ...brief,
      rooms: [...brief.rooms].reverse().map((r) => ({ ...r, quantity: 2 })),
    };
    const params = edit("reorder-edit", edited);
    const first = await call("set_brief", params);
    expect(first).toMatchObject({ ok: true, briefVersion: 2 });
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(await call("set_brief", edit("remove", emptyBrief))).toMatchObject({
      ok: true,
      briefVersion: 3,
    });
    expect(
      await call(
        "set_brief",
        edit("new", {
          ...emptyBrief,
          rooms: [{ id: "new", program: "hall", quantity: 1, hard: false }],
        }),
      ),
    ).toMatchObject({ ok: true, briefVersion: 4 });
    expect(await call("set_brief", edit("retired", brief))).toMatchObject({
      ok: false,
      code: "retired_requirement",
    });
    const calls = readHistory.mock.calls.length;
    expect(await call("set_brief", params)).toEqual(first);
    expect(readHistory).toHaveBeenCalledTimes(calls);
    const duplicate = {
      ...emptyBrief,
      rooms: [
        { id: "a", program: "hall", quantity: 1, hard: true },
        { id: "b", program: "hall", quantity: 1, hard: true },
      ],
    };
    expect(await call("set_brief", edit("semantic-duplicate", duplicate))).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(state().brief.version).toBe(4);
  });
});

describe("evaluation pins, bindings and atomicity", () => {
  it("advances the actual trusted run cursor and rejects absorption of another caller's head", async () => {
    await call("create_project", create(enclosure(), brief));
    await fork();
    const initial = state("option");
    store.createRun({
      id: "run",
      projectId: "p",
      ref: "option",
      status: "queued",
      outcome: null,
      instruction: "Synthetic registry run",
      revisionId: initial.revisionId,
      baselineRevisionId: initial.forkBase?.revisionId ?? null,
      briefVersion: initial.brief.version,
      strategySeed: null,
      budget: {},
      retryCount: 0,
    });
    store.updateRun("run", { status: "running" });
    const runContext: ToolContext = {
      ...ctx,
      role: "agent",
      runId: "run",
      scope: { projectId: "p", ref: "option" },
    };
    const params = change(
      "run-edit",
      [{ op: "tag_space", space: "S8", program: "bedroom", requirementId: "small" }],
      "option",
    );
    const applied = await call("apply_changes", params, runContext);
    expect(applied).toMatchObject({ ok: true });
    expect(store.readRun("run")).toMatchObject({
      initialRevisionId: initial.revisionId,
      revisionId: state("option").revisionId,
    });
    expect(state("option").revisionId).not.toBe(initial.revisionId);
    expect(await call("scorecard", { projectId: "p", ref: "option" }, runContext)).toMatchObject({
      ok: true,
      revisionId: store.readRun("run")?.revisionId,
    });
    await call(
      "apply_changes",
      change(
        "external-head",
        [{ op: "tag_space", space: "S8", label: "Another caller" }],
        "option",
      ),
    );
    expect(await call("apply_changes", change("absorb", [], "option"), runContext)).toMatchObject({
      ok: false,
      code: "stale_run",
    });
    expect(await call("apply_changes", params, runContext)).toEqual(applied);
    expect(
      await call("apply_changes", params, { ...runContext, runId: "missing-run" }),
    ).toMatchObject({ ok: false, code: "invalid_run_binding" });
  });

  it("rejects both old brief and mismatched/null baseline pins without a revision", async () => {
    await call("create_project", create());
    const old = change("old");
    await call("set_brief", edit("new-brief", brief));
    expect(await call("apply_changes", old)).toMatchObject({ ok: false, code: "stale_brief" });
    expect(
      await call("apply_changes", {
        ...change("wrong-main-base"),
        body: { ...change("unused").body, baselineRevisionId: "not-null" },
      }),
    ).toMatchObject({ ok: false, code: "stale_baseline" });
    await fork();
    const option = change("wrong-option-base", [], "option");
    expect(
      await call("apply_changes", {
        ...option,
        body: { ...option.body, baselineRevisionId: null },
      }),
    ).toMatchObject({ ok: false, code: "stale_baseline" });
    expect(state("option").revisionId).toBe(state().revisionId);
    expect(
      await call("set_brief", { ...edit("stale-metadata", emptyBrief), baseBriefVersion: 1 }),
    ).toMatchObject({ ok: false, code: "stale_brief" });
  });

  it("targets assigned requirements, rolls back invalid batches, and enforces credential role", async () => {
    await call("create_project", create(enclosure(), brief));
    const initial = state();
    expect(
      await call(
        "apply_changes",
        change("binding", [
          { op: "tag_space", space: "S8", program: "bedroom", requirementId: "large" },
        ]),
      ),
    ).toMatchObject({ ok: true });
    const score = await call("scorecard", { projectId: "p" });
    expect(score).toMatchObject({
      ok: true,
      baselineRevisionId: null,
      evaluatorVersion: "2.0",
      result: {
        requirements: [
          { id: "small", present: 0, spaces: [] },
          { id: "large", present: 1, spaces: ["S8"] },
        ],
        constraints: [{ met: false }],
      },
    });
    const before = state();
    expect(
      await call(
        "apply_changes",
        change("bad-binding", [{ op: "tag_space", space: "S8", program: "hall" }]),
      ),
    ).toMatchObject({ ok: false, code: "invalid_binding" });
    expect(state()).toEqual(before);
    expect(
      await call(
        "apply_changes",
        change("bad-batch", [
          { op: "tag_space", space: "S8", label: "Should roll back" },
          { op: "add_wall", start: { x: 6000, y: 0 }, end: { x: 6500, y: 500 }, thickness: 200 },
        ]),
      ),
    ).toMatchObject({ ok: false, code: "invalid_geometry" });
    expect(state()).toEqual(before);
    await call("apply_changes", change("lock", [{ op: "update_wall", id: "W1", locked: true }]));
    expect(
      await call(
        "apply_changes",
        change("agent-edit", [{ op: "update_wall", id: "W1", thickness: 300 }]),
        { ...ctx, role: "agent" },
      ),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(store.readSnapshot("p", initial.revisionId)).toEqual(initial.model);
  });

  it("requires assignment repair before program edits and stales other option results by brief version", async () => {
    await call("create_project", create(enclosure(), brief));
    await call(
      "apply_changes",
      change("assign", [
        { op: "tag_space", space: "S8", program: "bedroom", requirementId: "small" },
      ]),
    );
    await fork();
    const oldScore = await call("scorecard", { projectId: "p", ref: "option" });
    const updated = {
      ...brief,
      rooms: brief.rooms.map((r) => (r.id === "small" ? { ...r, program: "study" } : r)),
    };
    expect(await call("set_brief", edit("program-edit", updated))).toMatchObject({
      ok: false,
      code: "invalid_binding",
    });
    await call(
      "apply_changes",
      change("clear", [{ op: "tag_space", space: "S8", requirementId: null }]),
    );
    expect(await call("set_brief", edit("repaired-edit", updated))).toMatchObject({
      ok: true,
      briefVersion: 2,
    });
    expect(oldScore).toMatchObject({ ok: true, briefVersion: 1 });
    expect(await call("scorecard", { projectId: "p", ref: "option" })).toMatchObject({
      ok: true,
      briefVersion: 2,
      result: {
        gates: expect.arrayContaining([
          expect.objectContaining({
            gate: "requirement_bindings",
            passed: false,
            failures: expect.any(Array),
          }),
        ]),
      },
    });
    expect(
      await call(
        "apply_changes",
        change("option-repair", [{ op: "tag_space", space: "S8", program: "study" }], "option"),
      ),
    ).toMatchObject({ ok: true });
  });

  it("uses immutable fork model rather than current main for protection scoring", async () => {
    const locked = enclosure();
    locked.walls[0] = { ...(locked.walls[0] as Model["walls"][number]), locked: true };
    await call("create_project", create(locked));
    const baseline = state().revisionId;
    await fork();
    await call(
      "apply_changes",
      change("option-owner", [{ op: "update_wall", id: "W1", thickness: 300 }], "option"),
    );
    await call(
      "apply_changes",
      change("main-owner", [{ op: "update_wall", id: "W1", thickness: 300 }]),
    );
    const scored = await call("scorecard", { projectId: "p", ref: "option" });
    expect(scored).toMatchObject({
      ok: true,
      baselineRevisionId: baseline,
      result: {
        gates: expect.arrayContaining([
          expect.objectContaining({
            gate: "protected_intact",
            passed: false,
            failures: expect.any(Array),
          }),
        ]),
      },
    });
    expect(await call("scorecard", { projectId: "p" })).toMatchObject({
      ok: true,
      baselineRevisionId: null,
      result: {
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "protected_intact", passed: true, failures: [] }),
        ]),
      },
    });
  });

  it("replays the original geometry outcome after head/brief changes but rejects changed pins", async () => {
    await call("create_project", create());
    const params = change("replay", [
      { op: "add_wall", start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thickness: 200 },
    ]);
    const original = await call("apply_changes", params);
    await call("apply_changes", change("advance"));
    await call("set_brief", edit("new-brief", brief));
    expect(await call("apply_changes", params)).toEqual(original);
    expect(
      await call("apply_changes", { ...params, body: { ...params.body, briefVersion: 2 } }),
    ).toMatchObject({ ok: false, code: "request_conflict" });
    expect(
      await call("apply_changes", params, { ...ctx, scope: { projectId: "other", ref: "main" } }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("rejects shape-valid invalid topology on reads, fork and apply without healing history", async () => {
    const bad = enclosure();
    const command = { ...create(bad), type: "create_project" as const };
    expect(store.execute(command, { role: "owner", namespace: "fixture" })).toMatchObject({
      ok: true,
    });
    const initial = state();
    for (const tool of ["inspect_project", "scorecard"])
      expect(await call(tool, { projectId: "p" })).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
    expect(await fork()).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await call("apply_changes", change("no-healing"))).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(state()).toEqual(initial);
    expect(store.readSnapshot("p", initial.revisionId)).toEqual(bad);
  });

  it("inspect is JSON serializable and excludes the raster/grid internals", async () => {
    await call("create_project", create(enclosure()));
    const inspected = await call("inspect_project", { projectId: "p" });
    expect(inspected).toMatchObject({
      ok: true,
      projectId: "p",
      ref: "main",
      briefVersion: 1,
      baselineRevisionId: null,
      brief: emptyBrief,
      derived: { spaces: [{ id: "S8", netArea: 10_640_000 }], problems: [] },
    });
    expect(JSON.parse(JSON.stringify(inspected))).toEqual(inspected);
    expect((inspected as { derived: object }).derived).not.toHaveProperty("raster");
    expect((inspected as { derived: object }).derived).not.toHaveProperty("graph");
  });
});
