import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Caller,
  type Command,
  type CommandResult,
  MAX_RUN_EVALUATION_BYTES,
  openStore,
  type RefState,
  type RunEvaluation,
  type Store,
} from "../src/index.ts";

const owner: Caller = { role: "owner", namespace: "owner" };
const agent: Caller = { role: "agent", namespace: "workflow", runId: "run" };
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function storeAt(path = ":memory:"): Store {
  const store = openStore(path);
  stores.push(store);
  return store;
}
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "or1-runs-"));
  dirs.push(dir);
  return join(dir, "store.sqlite");
}
function accepted(result: CommandResult): Extract<CommandResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result;
}
const creation: Extract<Command, { type: "create_project" }> = {
  type: "create_project",
  projectId: "p",
  ref: "main",
  baseRevision: null,
  requestId: "create",
  body: { model: { counter: 0 }, brief: { max: 7 } },
};
function setup(store: Store): string {
  const base = accepted(store.execute(creation, owner)).revisionId;
  accepted(
    store.execute(
      {
        type: "fork_ref",
        projectId: "p",
        ref: "option",
        baseRevision: base,
        requestId: "fork",
        body: { sourceRef: "main" },
      },
      owner,
    ),
  );
  startRun(store);
  return base;
}
function startRun(store: Store, id = "run", ref = "option") {
  const state = store.readState("p", ref);
  if (!state) throw new Error("Missing state");
  store.createRun({
    id,
    projectId: "p",
    ref,
    status: "queued",
    outcome: null,
    instruction: "iterate",
    revisionId: state.revisionId,
    briefVersion: state.brief.version,
    baselineRevisionId: state.forkBase?.revisionId ?? null,
    strategySeed: null,
    budget: { turns: 4 },
    retryCount: 0,
  });
  store.updateRun(id, { status: "running" });
}
function change(
  baseRevision: string,
  requestId = "edit",
  ref = "option",
): Extract<Command, { type: "apply_changes" }> {
  return {
    type: "apply_changes",
    projectId: "p",
    ref,
    baseRevision,
    requestId,
    body: { delta: 1 },
  };
}
function increment(state: RefState) {
  const before = (state.model as { counter: number }).counter;
  return {
    ok: true as const,
    model: { counter: before + 1 },
    effects: [{ before, after: before + 1 }],
  };
}
function score(store: Store): RunEvaluation {
  const run = store.readRun("run");
  if (!run?.revisionId) throw new Error("Missing run");
  return {
    revisionId: run.revisionId,
    briefVersion: run.briefVersion,
    baselineRevisionId: run.baselineRevisionId,
    evaluatorVersion: "score-v2",
    result: { hard: [{ id: "r1", pass: true }], value: 11 },
  };
}
function history(store: Store) {
  return {
    revisions: store.db.prepare("SELECT * FROM revisions ORDER BY id").all(),
    refs: store.db.prepare("SELECT * FROM refs ORDER BY name").all(),
    outcomes: store.db.prepare("SELECT * FROM request_outcomes ORDER BY id").all(),
    run: store.readRun("run"),
  };
}

describe("trusted run-bound edits", () => {
  it("advances cursor through two own edits without changing provenance and replays old edits after completion/head change", () => {
    const store = storeAt();
    const base = setup(store);
    const first = change(base);
    const evaluate = vi.fn(increment);
    const r1 = accepted(store.execute(first, agent, evaluate));
    const r2 = accepted(store.execute(change(r1.revisionId, "second"), agent, evaluate));
    expect(store.readRun("run")).toMatchObject({
      initialRevisionId: base,
      revisionId: r2.revisionId,
      baselineRevisionId: base,
      briefVersion: 1,
    });
    expect(store.readState("p", "option")?.model).toEqual({ counter: 2 });
    expect(store.readSnapshot("p", base)).toEqual({ counter: 0 });
    expect(store.readSnapshot("p", r1.revisionId)).toEqual({ counter: 1 });
    expect(() =>
      store.db
        .prepare("UPDATE runs SET initial_revision_id = ? WHERE id = 'run'")
        .run(r2.revisionId),
    ).toThrow("immutable");
    store.updateRun("run", {
      revisionId: base,
      initialRevisionId: r2.revisionId,
      briefVersion: 9,
    } as never);
    expect(store.readRun("run")).toMatchObject({
      initialRevisionId: base,
      revisionId: r2.revisionId,
      briefVersion: 1,
    });
    const evaluation = score(store);
    accepted(store.finalizeRun("run", "options", evaluation));
    const outside = accepted(store.execute(change(r2.revisionId, "outside"), owner, increment));
    const before = history(store);
    expect(store.execute(first, agent, evaluate)).toEqual(r1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(history(store)).toEqual(before);
    expect(store.readState("p", "option")?.revisionId).toBe(outside.revisionId);
    expect(store.readRun("run")).toMatchObject({
      revisionId: r2.revisionId,
      status: "done",
      evaluation,
    });
  });

  it("denies externally advanced head laundering even when caller uses the new head", () => {
    const store = storeAt();
    const base = setup(store);
    const outside = accepted(store.execute(change(base, "outside"), owner, increment));
    const evaluate = vi.fn(increment);
    expect(store.execute(change(outside.revisionId), agent, evaluate)).toEqual({
      ok: false,
      code: "stale_run",
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(store.readRun("run")).toMatchObject({
      initialRevisionId: base,
      revisionId: base,
      outcome: null,
    });
    expect(store.readState("p", "option")?.revisionId).toBe(outside.revisionId);
  });

  it("requires running status for new edits but replays a queued rejection after the run starts", () => {
    const store = storeAt();
    const base = setup(store);
    store.updateRun("run", { status: "queued" });
    const evaluate = vi.fn(increment);
    const command = change(base);
    expect(store.execute(command, agent, evaluate)).toEqual({ ok: false, code: "run_not_running" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(store.readRun("run")?.revisionId).toBe(base);
    store.updateRun("run", { status: "running" });
    expect(store.execute(command, agent, evaluate)).toEqual({ ok: false, code: "run_not_running" });
    expect(evaluate).not.toHaveBeenCalled();
    accepted(store.execute(change(base, "running-edit"), agent, evaluate));
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it.each(["brief", "main", "fork"] as const)(
    "rejects stale %s context before evaluation",
    (pin) => {
      const store = storeAt();
      const base = setup(store);
      if (pin === "brief") {
        accepted(
          store.execute(
            {
              type: "set_brief",
              projectId: "p",
              ref: "main",
              baseRevision: base,
              requestId: "brief",
              body: { brief: { max: 9 }, baseBriefVersion: 1 },
            },
            owner,
          ),
        );
      } else if (pin === "main") {
        accepted(store.execute(change(base, "main-edit", "main"), owner, increment));
      } else {
        // Exercise mismatched fork context without mutating the immutable baseline of a row.
        store.db.prepare("DELETE FROM refs WHERE project_id = 'p' AND name = 'option'").run();
        store.db
          .prepare(
            "INSERT INTO refs (project_id, name, head_revision_id) VALUES ('p', 'option', ?)",
          )
          .run(base);
      }
      const evaluate = vi.fn(increment);
      expect(store.execute(change(base), agent, evaluate)).toEqual({
        ok: false,
        code: "stale_run",
      });
      expect(evaluate).not.toHaveBeenCalled();
      expect(store.readRun("run")?.revisionId).toBe(base);
    },
  );

  it("authenticates project/ref binding before replay, fingerprints binding/role but not cursor/status", () => {
    const store = storeAt();
    const base = setup(store);
    startRun(store, "other");
    startRun(store, "main-run", "main");
    const command = change(base);
    const result = accepted(store.execute(command, agent, increment));
    for (const caller of [
      { ...agent, runId: "other" },
      { role: "agent" as const, namespace: agent.namespace },
      { ...agent, role: "owner" as const },
    ])
      expect(store.execute(command, caller, increment)).toEqual({
        ok: false,
        code: "request_conflict",
      });
    for (const runId of ["missing", "main-run"]) {
      expect(store.execute(command, { ...agent, runId }, increment)).toEqual({
        ok: false,
        code: "invalid_run_binding",
      });
    }
    accepted(store.execute({ ...creation, projectId: "q" }, owner));
    expect(store.execute({ ...command, projectId: "q" }, agent, increment)).toEqual({
      ok: false,
      code: "invalid_run_binding",
    });
    expect(store.execute(command, { ...agent, runId: "x".repeat(129) }, increment)).toEqual({
      ok: false,
      code: "invalid_caller",
    });
    expect(store.execute({ ...creation, projectId: "new" }, { ...owner, runId: "run" })).toEqual({
      ok: false,
      code: "invalid_run_binding",
    });
    store.updateRun("run", { status: "interrupted" });
    expect(store.execute(command, agent)).toEqual(result);
    const evaluate = vi.fn(increment);
    expect(store.execute(change(result.revisionId, "new"), agent, evaluate)).toEqual({
      ok: false,
      code: "run_not_running",
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(() => store.updateRun("run", { status: "running" })).toThrow("finished");
  });

  it.each(["cursor", "outcome"] as const)(
    "rolls back revision, ref, cursor and request key on %s persistence failure",
    (failure) => {
      const store = storeAt();
      const base = setup(store);
      const before = history(store);
      if (failure === "cursor") {
        store.db.exec(
          "CREATE TRIGGER fail_cursor BEFORE UPDATE OF revision_id ON runs BEGIN SELECT RAISE(IGNORE); END;",
        );
      } else {
        store.db.exec(
          "CREATE TRIGGER fail_outcome BEFORE INSERT ON request_outcomes BEGIN SELECT RAISE(ABORT, 'outcome failure'); END;",
        );
      }
      expect(() => store.execute(change(base), agent, increment)).toThrow(
        failure === "cursor" ? "cursor advancement failed" : "outcome failure",
      );
      expect(history(store)).toEqual(before);
      store.db.exec(`DROP TRIGGER fail_${failure}`);
      const edited = accepted(store.execute(change(base), agent, increment));
      expect(store.readRun("run")?.revisionId).toBe(edited.revisionId);
    },
  );
});

describe("exact final evaluation", () => {
  it("cannot attach an R1 score after the run advances its own cursor to R2", () => {
    const store = storeAt();
    const base = setup(store);
    const r1 = accepted(store.execute(change(base), agent, increment));
    const old = score(store);
    const r2 = accepted(store.execute(change(r1.revisionId, "second"), agent, increment));
    expect(store.finalizeRun("run", "options", old)).toEqual({ ok: false, code: "stale_score" });
    for (const evaluation of [
      { ...score(store), briefVersion: 2 },
      { ...score(store), baselineRevisionId: null },
    ]) {
      expect(store.finalizeRun("run", "options", evaluation)).toEqual({
        ok: false,
        code: "stale_score",
      });
    }
    expect(store.readRun("run")).toMatchObject({
      status: "running",
      outcome: null,
      evaluation: null,
    });
    const current = score(store);
    const result = accepted(store.finalizeRun("run", "options", current));
    expect(result.revisionId).toBe(r2.revisionId);
    expect(store.readRun("run")?.evaluation).toEqual(current);
    expect(
      store.finalizeRun("run", "options", {
        result: current.result,
        evaluatorVersion: "score-v2",
        baselineRevisionId: base,
        briefVersion: 1,
        revisionId: r2.revisionId,
      }),
    ).toEqual(result);
    for (const changed of [
      { ...current, evaluatorVersion: "score-v3" },
      { ...current, result: { value: 12 } },
    ]) {
      expect(store.finalizeRun("run", "options", changed)).toEqual({
        ok: false,
        code: "run_finished",
      });
    }
    expect(store.readRun("run")?.evaluation).toEqual(current);
  });

  it("allows absent evaluation only for unscored budget completion", () => {
    const store = storeAt();
    setup(store);
    for (const outcome of ["options", "infeasible"] as const) {
      expect(store.finalizeRun("run", outcome)).toEqual({ ok: false, code: "score_required" });
    }
    expect(store.readRun("run")).toMatchObject({ status: "running", outcome: null });
    const result = accepted(store.finalizeRun("run", "not_found_within_budget"));
    expect(store.readRun("run")).toMatchObject({
      status: "done",
      outcome: "not_found_within_budget",
      evaluation: null,
    });
    expect(store.finalizeRun("run", "not_found_within_budget")).toEqual(result);
  });

  it("bounds complete evaluation UTF-8 bytes and rolls back failed score persistence", () => {
    const store = storeAt();
    setup(store);
    const empty = { ...score(store), result: "" };
    // JSON.stringify and canonical JSON differ only in key order, not encoded byte count.
    const overhead = Buffer.byteLength(JSON.stringify(empty));
    const exact = { ...empty, result: "x".repeat(MAX_RUN_EVALUATION_BYTES - overhead) };
    expect(store.finalizeRun("run", "options", { ...exact, result: `${exact.result}x` })).toEqual({
      ok: false,
      code: "score_too_large",
    });
    expect(
      store.finalizeRun("run", "options", {
        ...exact,
        result: "é".repeat((MAX_RUN_EVALUATION_BYTES - overhead) / 2 + 1),
      }),
    ).toEqual({ ok: false, code: "score_too_large" });
    expect(store.finalizeRun("run", "options", { ...empty, evaluatorVersion: "" })).toEqual({
      ok: false,
      code: "invalid_score",
    });
    const before = history(store);
    store.db.exec(
      "CREATE TRIGGER fail_score BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'score failure'); END;",
    );
    expect(() => store.finalizeRun("run", "options", exact)).toThrow("score failure");
    expect(history(store)).toEqual(before);
    store.db.exec("DROP TRIGGER fail_score");
    accepted(store.finalizeRun("run", "options", exact));
    expect(store.readRun("run")?.evaluation).toEqual(exact);
  });
});

describe("restart and v2 migration", () => {
  it("reloads an unfinished run with a missing turn, interrupts explicitly without resuming and permits old edit replay", () => {
    const path = databasePath();
    const first = openStore(path);
    let command: ReturnType<typeof change>;
    let edited: Extract<CommandResult, { ok: true }>;
    let base: string;
    try {
      base = setup(first);
      command = change(base);
      edited = accepted(first.execute(command, agent, increment));
      // Crash boundary: revision/outcome/cursor committed, turn transcript not yet persisted.
      startRun(first, "queued");
      first.updateRun("queued", { status: "queued" });
      startRun(first, "completed");
      accepted(first.finalizeRun("completed", "not_found_within_budget"));
    } finally {
      first.close();
    }
    const reloaded = storeAt(path);
    expect(reloaded.readRun("run")).toMatchObject({
      status: "running",
      initialRevisionId: base,
      revisionId: edited.revisionId,
    });
    expect(reloaded.readRunTurns("run")).toEqual([]);
    expect(reloaded.interruptRunningRuns()).toBe(1);
    expect(reloaded.interruptRunningRuns()).toBe(0);
    expect(reloaded.readRun("queued")?.status).toBe("queued");
    expect(reloaded.readRun("completed")?.status).toBe("done");
    expect(reloaded.readRun("run")).toMatchObject({
      status: "interrupted",
      outcome: null,
      evaluation: null,
    });
    expect(() => reloaded.updateRun("run", { status: "running" })).toThrow("finished");
    expect(reloaded.execute(command, agent)).toEqual(edited);
    expect(reloaded.readRun("run")).toMatchObject({
      status: "interrupted",
      revisionId: edited.revisionId,
    });
    expect(reloaded.finalizeRun("run", "not_found_within_budget")).toEqual({
      ok: false,
      code: "run_finished",
    });
  });

  it("migrates fixed v2 pins into provenance and preserves v2 unbound fingerprints/outcomes", () => {
    const path = databasePath();
    const old = openStore(path);
    let created: CommandResult;
    let base: string;
    try {
      created = old.execute(creation, owner);
      base = accepted(created).revisionId;
      startRun(old, "run", "main");
      startRun(old, "historical-done", "main");
      old.db.exec(
        "UPDATE runs SET status = 'done', outcome = 'options' WHERE id = 'historical-done'",
      );
      const v2Fingerprint = createHash("sha256")
        .update(
          '{"command":{"baseRevision":null,"body":{"brief":{"max":7},"model":{"counter":0}},"projectId":"p","ref":"main","requestId":"create","type":"create_project"},"context":{"brief":null,"forkBase":null},"role":"owner"}',
        )
        .digest("hex");
      old.db
        .prepare("UPDATE request_outcomes SET fingerprint = ? WHERE request_id = 'create'")
        .run(v2Fingerprint);
      old.db.exec(
        "DROP TRIGGER immutable_run_pins; DROP TRIGGER initial_run_project; ALTER TABLE runs DROP COLUMN initial_revision_id; ALTER TABLE runs DROP COLUMN evaluation; PRAGMA user_version = 2;",
      );
    } finally {
      old.close();
    }
    const migrated = storeAt(path);
    expect(migrated.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(migrated.readRun("run")).toMatchObject({
      initialRevisionId: base,
      revisionId: base,
      evaluation: null,
      status: "running",
    });
    expect(migrated.readRun("historical-done")).toMatchObject({
      initialRevisionId: base,
      revisionId: base,
      evaluation: null,
      status: "done",
      outcome: "options",
    });
    expect(migrated.finalizeRun("historical-done", "options")).toEqual({
      ok: false,
      code: "run_finished",
    });
    expect(migrated.execute(creation, owner)).toEqual(created);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
