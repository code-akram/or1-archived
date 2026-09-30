import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  type AcceptanceCommand,
  type Command,
  type CommandResult,
  createStore,
  type SqlDriver,
  type SqlRow,
} from "@or1/store/portable";
import { afterEach, describe, expect, it, vi } from "vitest";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A driver with a transactional metatable, no user_version, and no SQL control escape. */
function metatableDriver(version = 0) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE driver_version (version INTEGER NOT NULL)");
  db.prepare("INSERT INTO driver_version VALUES (?)").run(version);
  const modes: ("read" | "write")[] = [];
  const versions: number[] = [];
  let active: "read" | "write" | undefined;
  const checkSql = (sql: string) => {
    expect(sql).not.toMatch(/\b(?:PRAGMA|BEGIN IMMEDIATE|COMMIT|ROLLBACK)\b/i);
  };
  const driver: SqlDriver = {
    prepare: (sql) => {
      checkSql(sql);
      const statement = db.prepare(sql);
      return {
        get: (...bindings) => statement.get(...bindings) as SqlRow | undefined,
        all: (...bindings) => statement.all(...bindings) as SqlRow[],
        run: (...bindings) => {
          statement.run(...bindings);
          return { changes: Number(db.prepare("SELECT changes() AS n").get()?.n) };
        },
      };
    },
    exec: (sql) => {
      checkSql(sql);
      db.exec(sql);
    },
    transaction: (callback, mode) => {
      expect(active).toBeUndefined();
      active = mode;
      modes.push(mode);
      db.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        const result = callback();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        active = undefined;
      }
    },
    getSchemaVersion: () => {
      expect(active).toBe("write");
      return Number(db.prepare("SELECT version FROM driver_version").get()?.version);
    },
    setSchemaVersion: (next) => {
      expect(active).toBe("write");
      versions.push(next);
      db.prepare("UPDATE driver_version SET version = ?").run(next);
    },
    // Track ownership without closing so tests can inspect a rolled-back initializer.
    close: vi.fn(),
  };
  return { db, driver, modes, versions };
}

function accepted<T extends CommandResult>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result as Extract<T, { ok: true }>;
}
const owner = { role: "owner" as const, namespace: "owner" };
const creation: Extract<Command, { type: "create_project" }> = {
  type: "create_project",
  projectId: "p",
  ref: "main",
  baseRevision: null,
  requestId: "create",
  body: { model: { counter: 0 }, brief: { max: 7 } },
};

describe("portable SQL seam", () => {
  it("migrates with driver version storage, not SQLite user_version, and delegates close", () => {
    const { db, driver, modes, versions } = metatableDriver();
    const store = createStore(driver);
    expect(versions).toEqual([1, 2, 3]);
    expect(modes).toEqual(["write"]);
    expect(db.prepare("SELECT version FROM driver_version").get()?.version).toBe(3);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
    expect(store).not.toHaveProperty("db");
    createStore(driver);
    expect(versions).toEqual([1, 2, 3]);
    expect(modes).toEqual(["write", "write"]);
    store.close();
    expect(driver.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("rolls back schema and metatable version together when the final version write fails", () => {
    const { db, driver, versions } = metatableDriver();
    const setVersion = driver.setSchemaVersion;
    driver.setSchemaVersion = (version) => {
      setVersion(version);
      if (version === 3) throw new Error("version persistence failure");
    };
    expect(() => createStore(driver)).toThrow("version persistence failure");
    expect(versions).toEqual([1, 2, 3]);
    expect(db.prepare("SELECT version FROM driver_version").get()?.version).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
      { name: "driver_version" },
    ]);
    expect(driver.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("rejects future versions and closes the driver without changing its schema", () => {
    const { db, driver, modes, versions } = metatableDriver(4);
    expect(() => createStore(driver)).toThrow("Unsupported store schema version 4");
    expect(modes).toEqual(["write"]);
    expect(versions).toEqual([]);
    expect(db.prepare("SELECT version FROM driver_version").get()?.version).toBe(4);
    expect(driver.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("retains historical fingerprint bytes and authorizes before replay or driver transactions", () => {
    const { db, driver, modes } = metatableDriver();
    const store = createStore(driver);
    const created = accepted(store.execute(creation, owner));
    // Literal v2 identity, independent of the engine's serializer and its current context.
    const expected = createHash("sha256")
      .update(
        '{"command":{"baseRevision":null,"body":{"brief":{"max":7},"model":{"counter":0}},"projectId":"p","ref":"main","requestId":"create","type":"create_project"},"context":{"brief":null,"forkBase":null},"role":"owner"}',
      )
      .digest("hex");
    expect(db.prepare("SELECT fingerprint FROM request_outcomes").get()?.fingerprint).toBe(
      expected,
    );
    expect(store.execute(creation, { ...owner, role: "external" })).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(modes).toEqual(["write", "write"]);
    accepted(
      store.execute(
        {
          type: "set_brief",
          projectId: "p",
          ref: "main",
          baseRevision: created.revisionId,
          requestId: "brief",
          body: { brief: { max: 13 }, baseBriefVersion: 1 },
        },
        owner,
      ),
    );
    expect(store.execute(creation, owner)).toEqual(created);
    expect(store.readBriefs("p")).toEqual([
      { version: 1, body: { max: 7 } },
      { version: 2, body: { max: 13 } },
    ]);
  });

  it("delegates review/read and all ledger/write boundaries and promotes exact snapshot bytes", () => {
    const { db, driver, modes } = metatableDriver();
    const store = createStore(driver);
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
    store.createRun({
      id: "run",
      projectId: "p",
      ref: "option",
      revisionId: base,
      baselineRevisionId: base,
      briefVersion: 1,
      status: "queued",
      outcome: null,
      instruction: "synthetic",
      strategySeed: null,
      budget: { turns: 2 },
      retryCount: 0,
    });
    store.updateRun("run", { status: "running" });
    const changed = accepted(
      store.execute(
        {
          type: "apply_changes",
          projectId: "p",
          ref: "option",
          baseRevision: base,
          requestId: "edit",
          body: { delta: 3 },
        },
        { role: "agent", namespace: "workflow", runId: "run" },
        () => ({ ok: true, model: { counter: 3 }, effects: [{ delta: 3 }] }),
      ),
    );
    expect(store.readRun("run")).toMatchObject({
      revisionId: changed.revisionId,
      initialRevisionId: base,
    });
    store.saveRunTurn({ runId: "run", turn: 0, transcript: ["é"], result: [3, 1], spend: null });
    expect(store.readRunTurns("run")).toEqual([
      { runId: "run", turn: 0, transcript: ["é"], result: [3, 1], spend: null },
    ]);
    accepted(store.finalizeRun("run", "not_found_within_budget"));
    expect(store.interruptRunningRuns()).toBe(0);
    // Simulate historical formatting, not a new geometry write through the store.
    const snapshot = '{ "untouched": [9, 2], "counter": 23 }';
    db.prepare("INSERT INTO revisions VALUES ('formatted', 'p', ?, '{}', ?, 'old')").run(
      changed.revisionId,
      snapshot,
    );
    db.prepare("UPDATE refs SET head_revision_id = 'formatted' WHERE name = 'option'").run();
    const command: AcceptanceCommand = {
      type: "accept_option",
      projectId: "p",
      ref: "main",
      baseRevision: base,
      requestId: "accept",
      body: {
        sourceRef: "option",
        sourceRevisionId: "formatted",
        briefVersion: 1,
        baselineRevisionId: base,
        evaluatorVersion: "score-v1",
      },
    };
    expect(store.readReview("p", "option")).toMatchObject({
      ok: true,
      states: { source: { model: { untouched: [9, 2], counter: 23 } } },
    });
    const promoted = accepted(
      store.execute(command, owner, () => ({
        ok: true,
        evaluation: { evaluatorVersion: "score-v1", result: { value: 17 } },
      })),
    );
    expect(
      db.prepare("SELECT snapshot FROM revisions WHERE id = ?").get(promoted.revisionId)?.snapshot,
    ).toBe(snapshot);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(modes).toEqual([
      "write", // initialization
      "write", // create project
      "write", // fork
      "write", // create run
      "write", // update run
      "write", // geometry and cursor
      "write", // turn
      "write", // finalization
      "write", // interruption
      "read", // coherent review
      "write", // acceptance
    ]);
  });
});
