import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AcceptanceCommand,
  type AcceptanceEvaluator,
  type AcceptanceReceipt,
  type Caller,
  type CommandResult,
  MAX_ACCEPTANCE_RECEIPT_BYTES,
  openStore,
  type Store,
} from "../src/index.ts";

const owner: Caller = { role: "owner", namespace: "owner-credential" };
const agent: Caller = { role: "agent", namespace: "workflow" };
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
  const dir = mkdtempSync(join(tmpdir(), "or1-acceptance-"));
  dirs.push(dir);
  return join(dir, "store.sqlite");
}
function success<T extends CommandResult>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result as Extract<T, { ok: true }>;
}
function create(store: Store, projectId = "p", ref = "main"): string {
  return success(
    store.execute(
      {
        type: "create_project",
        projectId,
        ref,
        baseRevision: null,
        requestId: "create",
        body: { model: { counter: 3, untouched: [4, 9] }, brief: { max: 20 } },
      },
      owner,
    ),
  ).revisionId;
}
function fork(store: Store, base: string, ref = "option") {
  success(
    store.execute(
      {
        type: "fork_ref",
        projectId: "p",
        ref,
        baseRevision: base,
        requestId: `fork-${ref}`,
        body: { sourceRef: "main" },
      },
      owner,
    ),
  );
}
function edit(
  store: Store,
  ref: string,
  baseRevision: string,
  requestId: string,
  counter = 11,
): string {
  return success(
    store.execute(
      {
        type: "apply_changes",
        projectId: "p",
        ref,
        baseRevision,
        requestId,
        body: { counter },
      },
      ref === "main" ? owner : agent,
      () => ({
        ok: true,
        model: { counter, untouched: [4, 9] },
        effects: [{ counter }],
      }),
    ),
  ).revisionId;
}
function brief(store: Store, base: string, version = 1) {
  success(
    store.execute(
      {
        type: "set_brief",
        projectId: "p",
        ref: "main",
        baseRevision: base,
        requestId: `brief-${version}`,
        body: { brief: { max: 30 + version }, baseBriefVersion: version },
      },
      owner,
    ),
  );
}
function setup(store: Store): AcceptanceCommand {
  const base = create(store);
  fork(store, base);
  const source = edit(store, "option", base, "option-edit");
  return {
    type: "accept_option",
    projectId: "p",
    ref: "main",
    baseRevision: base,
    requestId: "accept",
    body: {
      sourceRef: "option",
      sourceRevisionId: source,
      briefVersion: 1,
      baselineRevisionId: base,
      evaluatorVersion: "test-v1",
    },
  };
}
const evaluate: AcceptanceEvaluator = () => ({
  ok: true,
  evaluation: { evaluatorVersion: "test-v1", result: { asymmetric: [5, 2], value: 17 } },
});
function history(store: Store) {
  return {
    revisions: store.db.prepare("SELECT * FROM revisions ORDER BY id").all(),
    refs: store.db.prepare("SELECT * FROM refs ORDER BY name").all(),
    briefs: store.readBriefs("p"),
    runs: store.db.prepare("SELECT * FROM runs ORDER BY id").all(),
    outcomes: store.db.prepare("SELECT * FROM request_outcomes ORDER BY id").all(),
  };
}

describe("snapshot acceptance", () => {
  it("persists exact source bytes, provenance and immutable history across disk reopen", () => {
    const path = databasePath();
    const first = openStore(path);
    let command: AcceptanceCommand;
    let result: ReturnType<typeof first.execute>;
    let before: ReturnType<typeof history>;
    try {
      command = setup(first);
      // Historical source formatting must be copied byte-for-byte, not reserialized.
      first.db
        .prepare("INSERT INTO revisions VALUES ('formatted', 'p', ?, '{}', ?, 'old')")
        .run(command.body.sourceRevisionId, '{ "counter": 23, "untouched": [4, 9] }');
      first.db
        .prepare("UPDATE refs SET head_revision_id = 'formatted' WHERE name = 'option'")
        .run();
      command.body.sourceRevisionId = "formatted";
      before = history(first);
      const callback = vi.fn((states: Parameters<AcceptanceEvaluator>[0]) => {
        expect(states.main.model).toEqual({ counter: 3, untouched: [4, 9] });
        expect(states.source.model).toEqual({ counter: 23, untouched: [4, 9] });
        // The store must not accidentally promote an evaluator-supplied or mutated model.
        states.source.model = { counter: 999 };
        return evaluate(states);
      });
      result = success(first.execute(command, owner, callback));
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      first.close();
    }
    const reopened = storeAt(path);
    const accepted = success(result);
    const receipt: AcceptanceReceipt = {
      ...command.body,
      schemaVersion: 1,
      projectId: "p",
      previousMainRevisionId: command.baseRevision,
      requestId: "accept",
      actor: { role: "owner", namespace: owner.namespace },
      scorecard: { asymmetric: [5, 2], value: 17 },
    };
    expect(accepted).toEqual({
      ok: true,
      revisionId: accepted.revisionId,
      briefVersion: 1,
      effects: [],
      acceptance: receipt,
    });
    const revision = reopened.db
      .prepare("SELECT * FROM revisions WHERE id = ?")
      .get(accepted.revisionId);
    expect(revision).toMatchObject({
      project_id: "p",
      parent_id: command.baseRevision,
      snapshot: '{ "counter": 23, "untouched": [4, 9] }',
    });
    expect(JSON.parse(String(revision?.change_set))).toEqual({
      type: "accept_option",
      command,
      acceptance: receipt,
    });
    expect(reopened.readState("p", "main")).toMatchObject({
      revisionId: accepted.revisionId,
      model: { counter: 23, untouched: [4, 9] },
      forkBase: null,
    });
    const after = history(reopened);
    expect(after.revisions.filter((row) => row.id !== accepted.revisionId)).toEqual(
      before.revisions,
    );
    expect(after.refs.filter((row) => row.name !== "main")).toEqual(
      before.refs.filter((row) => row.name !== "main"),
    );
    expect(after.briefs).toEqual(before.briefs);
    expect(after.runs).toEqual(before.runs);
    expect(after.outcomes.slice(0, -1)).toEqual(before.outcomes);
    expect(reopened.execute(command, owner)).toEqual(accepted);
    expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(reopened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      reopened.db
        .prepare("UPDATE revisions SET snapshot = '{}' WHERE id = ?")
        .run(accepted.revisionId),
    ).toThrow("immutable");
  });

  it.each(["base", "source", "brief", "baseline", "fork-main", "evaluator"] as const)(
    "rejects stale %s without promotion or premature evaluation",
    (pin) => {
      const store = storeAt();
      let command = setup(store);
      if (pin === "base") edit(store, "main", command.baseRevision, "main-edit");
      if (pin === "source") edit(store, "option", command.body.sourceRevisionId, "source-edit");
      if (pin === "brief") brief(store, command.baseRevision);
      if (pin === "baseline")
        command = {
          ...command,
          body: { ...command.body, baselineRevisionId: command.body.sourceRevisionId },
        };
      if (pin === "fork-main") {
        const main = edit(store, "main", command.baseRevision, "main-edit");
        // Passing the new main baseline cannot launder a fork pinned to the old one.
        command = {
          ...command,
          baseRevision: main,
          body: { ...command.body, baselineRevisionId: main },
        };
      }
      const before = history(store);
      const callback = vi.fn(
        pin === "evaluator"
          ? () => ({
              ok: true as const,
              evaluation: { evaluatorVersion: "test-v2", result: { value: 8 } },
            })
          : evaluate,
      );
      const code = {
        base: "stale_base",
        source: "stale_source",
        brief: "stale_brief",
        baseline: "stale_baseline",
        "fork-main": "stale_baseline",
        evaluator: "stale_evaluator",
      }[pin];
      expect(store.execute(command, owner, callback)).toEqual({ ok: false, code });
      expect(callback).toHaveBeenCalledTimes(pin === "evaluator" ? 1 : 0);
      const after = history(store);
      expect({ ...after, outcomes: before.outcomes }).toEqual(before);
      expect(after.outcomes).toHaveLength(before.outcomes.length + 1);
      expect(store.execute(command, owner, callback)).toEqual({ ok: false, code });
      expect(callback).toHaveBeenCalledTimes(pin === "evaluator" ? 1 : 0);
    },
  );

  it("replays reordered identical commands after every pin changes, but altered commands conflict", () => {
    const store = storeAt();
    const command = setup(store);
    const callback = vi.fn(evaluate);
    const accepted = success(store.execute(command, owner, callback));
    edit(store, "main", accepted.revisionId, "main-later", 15);
    edit(store, "option", command.body.sourceRevisionId, "source-later", 14);
    brief(store, store.readState("p", "main")?.revisionId as string);
    const before = history(store);
    const reordered: AcceptanceCommand = {
      requestId: command.requestId,
      baseRevision: command.baseRevision,
      ref: "main",
      projectId: "p",
      type: "accept_option",
      body: {
        evaluatorVersion: "test-v1",
        baselineRevisionId: command.baseRevision,
        briefVersion: 1,
        sourceRevisionId: command.body.sourceRevisionId,
        sourceRef: "option",
      },
    };
    const changedEvaluator = vi.fn(() => ({
      ok: true as const,
      evaluation: { evaluatorVersion: "test-v2", result: {} },
    }));
    expect(store.execute(reordered, owner, changedEvaluator)).toEqual(accepted);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(changedEvaluator).not.toHaveBeenCalled();
    for (const changed of [
      { ...command, baseRevision: accepted.revisionId },
      ...Object.entries({
        sourceRef: "other",
        sourceRevisionId: accepted.revisionId,
        briefVersion: 2,
        baselineRevisionId: accepted.revisionId,
        evaluatorVersion: "test-v2",
      }).map(([key, value]) => ({ ...command, body: { ...command.body, [key]: value } })),
      { ...command, type: "apply_changes" as const, body: {} },
    ])
      expect(store.execute(changed, owner)).toEqual({ ok: false, code: "request_conflict" });
    expect(history(store)).toEqual(before);
  });

  it("authorizes acceptance and main edits before replay and forbids run-bound acceptance", () => {
    const store = storeAt();
    const command = setup(store);
    const accepted = success(store.execute(command, owner, evaluate));
    const before = history(store);
    for (const role of ["agent", "external"] as const) {
      expect(store.execute(command, { ...owner, role }, evaluate)).toEqual({
        ok: false,
        code: "forbidden",
      });
      expect(
        store.execute({ ...command, requestId: `new-${role}` }, { ...owner, role }, evaluate),
      ).toEqual({ ok: false, code: "forbidden" });
    }
    expect(store.execute(command, { ...owner, runId: "missing" }, evaluate)).toEqual({
      ok: false,
      code: "invalid_run_binding",
    });
    expect(history(store)).toEqual(before);
    const editCommand = {
      type: "apply_changes" as const,
      projectId: "p",
      ref: "main",
      baseRevision: accepted.revisionId,
      requestId: "owner-edit",
      body: {},
    };
    success(store.execute(editCommand, owner, () => ({ ok: true, model: {}, effects: [] })));
    const after = history(store);
    for (const role of ["agent", "external"] as const) {
      expect(store.execute(editCommand, { ...owner, role })).toEqual({
        ok: false,
        code: "forbidden",
      });
      expect(
        store.execute({ ...editCommand, requestId: `main-${role}` }, { ...owner, role }),
      ).toEqual({ ok: false, code: "forbidden" });
    }
    expect(history(store)).toEqual(after);
  });

  it("blocks a genuine historical agent main success before cached replay", () => {
    const store = storeAt();
    const base = create(store);
    const command = {
      type: "apply_changes" as const,
      projectId: "p",
      ref: "main",
      baseRevision: base,
      requestId: "historical",
      body: {},
    };
    const outcome = { ok: true, revisionId: base, briefVersion: 1, effects: [] };
    const context = '{"brief":{"body":{"max":20},"version":1},"forkBase":null}';
    const fingerprint = createHash("sha256")
      .update(
        `{"command":{"baseRevision":${JSON.stringify(base)},"body":{},"projectId":"p","ref":"main","requestId":"historical","type":"apply_changes"},"context":${context},"role":"agent"}`,
      )
      .digest("hex");
    store.db
      .prepare(
        "INSERT INTO request_outcomes (project_id, namespace, request_id, role, fingerprint, context, revision_id, outcome) VALUES ('p', 'workflow', 'historical', 'agent', ?, ?, ?, ?)",
      )
      .run(fingerprint, context, base, JSON.stringify(outcome));
    const before = history(store);
    expect(store.execute(command, agent)).toEqual({ ok: false, code: "forbidden" });
    expect(history(store)).toEqual(before);
  });

  it("caches callback rejection without mutation and never re-evaluates it", () => {
    const store = storeAt();
    const command = setup(store);
    const before = history(store);
    const reject = vi.fn(() => ({
      ok: false as const,
      code: "hard_constraints",
      details: { failed: ["r2"] },
    }));
    const result = store.execute(command, owner, reject);
    expect(result).toEqual({ ok: false, code: "hard_constraints", details: { failed: ["r2"] } });
    const after = history(store);
    expect({ ...after, outcomes: before.outcomes }).toEqual(before);
    brief(store, command.baseRevision);
    expect(store.execute(command, owner, reject)).toEqual(result);
    expect(reject).toHaveBeenCalledTimes(1);
  });

  it.each([
    "throw",
    "async",
    "malformed",
    "malformed-message",
    "missing-score",
    "non-json",
    "missing-callback",
  ] as const)("rolls back %s callback without consuming the key", (failure) => {
    const store = storeAt();
    const command = setup(store);
    const before = history(store);
    const callback = {
      throw: () => {
        throw new Error("transient failure");
      },
      async: () =>
        Promise.resolve({ ok: true, evaluation: { evaluatorVersion: "test-v1", result: {} } }),
      malformed: () => ({ ok: false }),
      "malformed-message": () => ({ ok: false, code: "rejected", message: 4 }),
      "missing-score": () => ({ ok: true, evaluation: { evaluatorVersion: "test-v1" } }),
      "non-json": () => ({
        ok: true,
        evaluation: { evaluatorVersion: "test-v1", result: Infinity },
      }),
      "missing-callback": undefined,
    }[failure] as AcceptanceEvaluator | undefined;
    expect(() => store.execute(command, owner, callback)).toThrow();
    expect(history(store)).toEqual(before);
    success(store.execute(command, owner, evaluate));
  });

  it("caps the complete receipt at exactly 65536 canonical UTF-8 bytes", () => {
    const store = storeAt();
    const command = setup(store);
    const emptyReceipt: AcceptanceReceipt = {
      ...command.body,
      schemaVersion: 1,
      projectId: "p",
      previousMainRevisionId: command.baseRevision,
      requestId: command.requestId,
      actor: { role: "owner", namespace: owner.namespace },
      scorecard: "",
    };
    const overhead = Buffer.byteLength(JSON.stringify(emptyReceipt));
    const exact = "x".repeat(MAX_ACCEPTANCE_RECEIPT_BYTES - overhead);
    const before = history(store);
    const callback =
      (result: unknown): AcceptanceEvaluator =>
      () => ({
        ok: true,
        evaluation: { evaluatorVersion: "test-v1", result },
      });
    for (const [index, scorecard] of [
      `${exact}x`,
      "é".repeat(Math.floor(exact.length / 2) + 1),
    ].entries()) {
      const oversized = { ...command, requestId: `accept-${index}` };
      expect(store.execute(oversized, owner, callback(scorecard))).toEqual({
        ok: false,
        code: "score_too_large",
      });
      expect(store.readState("p", "main")?.revisionId).toBe(command.baseRevision);
    }
    expect(history(store).revisions).toEqual(before.revisions);
    const accepted = success(store.execute(command, owner, callback(exact)));
    expect(Buffer.byteLength(JSON.stringify(accepted.acceptance))).toBe(
      MAX_ACCEPTANCE_RECEIPT_BYTES,
    );
    expect(accepted.acceptance.scorecard).toBe(exact);
  });

  it("rolls back promotion and main movement if outcome persistence fails", () => {
    const store = storeAt();
    const command = setup(store);
    const before = history(store);
    store.db.exec(
      "CREATE TRIGGER fail_outcome BEFORE INSERT ON request_outcomes BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
    );
    expect(() => store.execute(command, owner, evaluate)).toThrow("disk failure");
    expect(history(store)).toEqual(before);
    store.db.exec("DROP TRIGGER fail_outcome");
    success(store.execute(command, owner, evaluate));
  });

  it("serializes competing acceptances across connections and commits at most one", () => {
    const path = databasePath();
    const first = storeAt(path);
    const command = setup(first);
    fork(first, command.baseRevision, "other-option");
    const otherSource = edit(first, "other-option", command.baseRevision, "other-edit", 29);
    const second = storeAt(path);
    second.db.exec("PRAGMA busy_timeout = 0");
    const competing: AcceptanceCommand = {
      ...command,
      requestId: "competing",
      body: { ...command.body, sourceRef: "other-option", sourceRevisionId: otherSource },
    };
    const callback = vi.fn((states: Parameters<AcceptanceEvaluator>[0]) => {
      expect(() => second.execute(competing, owner, evaluate)).toThrow("locked");
      return evaluate(states);
    });
    const accepted = success(first.execute(command, owner, callback));
    const stale = vi.fn(evaluate);
    expect(second.execute(competing, owner, stale)).toEqual({ ok: false, code: "stale_base" });
    expect(stale).not.toHaveBeenCalled();
    expect(first.readState("p", "main")?.revisionId).toBe(accepted.revisionId);
    const promoted = first.db
      .prepare("SELECT change_set FROM revisions")
      .all()
      .filter((row) => JSON.parse(String(row.change_set)).type === "accept_option");
    expect(promoted).toHaveLength(1);
  });

  it("rejects main/nonfork, missing and cross-project sources and revision IDs", () => {
    const store = storeAt();
    const command = setup(store);
    const foreign = create(store, "q", "foreign-only");
    store.db
      .prepare("INSERT INTO refs (project_id, name, head_revision_id) VALUES ('p', 'nonfork', ?)")
      .run(command.baseRevision);
    const callback = vi.fn(evaluate);
    for (const [index, sourceRef, code] of [
      [0, "main", "invalid_ref"],
      [1, "nonfork", "invalid_ref"],
      [2, "foreign-only", "ref_not_found"],
      [3, "absent", "ref_not_found"],
    ] as const) {
      expect(store.readReview("p", sourceRef)).toEqual({ ok: false, code });
      expect(
        store.execute(
          { ...command, requestId: `bad-${index}`, body: { ...command.body, sourceRef } },
          owner,
          callback,
        ),
      ).toEqual({ ok: false, code });
    }
    for (const sourceRevisionId of [foreign, "missing"]) {
      expect(
        store.execute(
          { ...command, requestId: sourceRevisionId, body: { ...command.body, sourceRevisionId } },
          owner,
          callback,
        ),
      ).toEqual({ ok: false, code: "stale_source" });
    }
    expect(
      store.execute(
        { ...command, ref: "option", requestId: "bad-target" } as never,
        owner,
        callback,
      ),
    ).toEqual({ ok: false, code: "invalid_ref" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not modify an active run but makes new edits/finalization stale after acceptance", () => {
    const store = storeAt();
    const command = setup(store);
    store.createRun({
      id: "run",
      projectId: "p",
      ref: "option",
      status: "queued",
      outcome: null,
      instruction: "try",
      revisionId: command.body.sourceRevisionId,
      baselineRevisionId: command.baseRevision,
      briefVersion: 1,
      strategySeed: null,
      budget: { turns: 3 },
      retryCount: 0,
    });
    store.updateRun("run", { status: "running" });
    const before = store.readRun("run");
    success(store.execute(command, owner, evaluate));
    expect(store.readRun("run")).toEqual(before);
    const callback = vi.fn(() => ({ ok: true as const, model: {}, effects: [] }));
    expect(
      store.execute(
        {
          type: "apply_changes",
          projectId: "p",
          ref: "option",
          requestId: "new-edit",
          baseRevision: command.body.sourceRevisionId,
          body: {},
        },
        { ...agent, runId: "run" },
        callback,
      ),
    ).toEqual({ ok: false, code: "stale_run" });
    expect(callback).not.toHaveBeenCalled();
    expect(store.finalizeRun("run", "not_found_within_budget")).toEqual({
      ok: false,
      code: "stale_run",
    });
    expect(store.readRun("run")).toEqual(before);
  });
});

describe("coherent review reads", () => {
  it("reads main, source and brief from one WAL snapshot without reserving a write lock", () => {
    const path = databasePath();
    const reader = storeAt(path);
    const command = setup(reader);
    const writer = storeAt(path);
    writer.db.exec("PRAGMA busy_timeout = 0");
    const before = { main: reader.readState("p", "main"), source: reader.readState("p", "option") };
    const prepare = reader.db.prepare.bind(reader.db);
    let stateReads = 0;
    const spy = vi.spyOn(reader.db, "prepare").mockImplementation((sql) => {
      if (sql.includes("SELECT f.head_revision_id") && ++stateReads === 2) {
        const main = edit(writer, "main", command.baseRevision, "concurrent-main", 21);
        edit(writer, "option", command.body.sourceRevisionId, "concurrent-source", 22);
        brief(writer, main);
      }
      return prepare(sql);
    });
    try {
      expect(reader.readReview("p", "option")).toEqual({ ok: true, states: before });
    } finally {
      spy.mockRestore();
    }
    expect(reader.readState("p", "main")).toMatchObject({
      model: { counter: 21 },
      brief: { version: 2 },
    });
    expect(reader.readState("p", "option")).toMatchObject({
      model: { counter: 22 },
      brief: { version: 2 },
    });
    expect(reader.readReview("missing", "option")).toEqual({
      ok: false,
      code: "project_not_found",
    });
    expect(reader.readReview("p", "")).toEqual({ ok: false, code: "invalid_command" });
  });
});
