import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Caller,
  type Command,
  type CommandResult,
  MAX_RUN_TURN_BYTES,
  openStore,
  type RunRecord,
  type Store,
} from "../src/index.ts";

const owner: Caller = { role: "owner", namespace: "credential-a" };
const agent: Caller = { role: "agent", namespace: "credential-a" };
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
function accepted(result: CommandResult): Extract<CommandResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result;
}
function create(store: Store, projectId = "p"): string {
  return accepted(
    store.execute(
      {
        type: "create_project",
        projectId,
        ref: "main",
        baseRevision: null,
        requestId: "create",
        body: { model: { counter: 7 }, brief: { max: 20 } },
      },
      owner,
    ),
  ).revisionId;
}
function change(
  baseRevision: string,
  requestId = "change",
  projectId = "p",
  ref = "main",
): Extract<Command, { type: "apply_changes" }> {
  return {
    type: "apply_changes",
    projectId,
    ref,
    baseRevision,
    requestId,
    body: { amount: 3, nested: { b: 2, a: 1 } },
  };
}
const evaluate = () => ({
  ok: true as const,
  model: { counter: 10 },
  effects: [{ before: 7, after: 10 }],
});
function counts(store: Store) {
  return ["projects", "refs", "revisions", "briefs", "request_outcomes"].map((table) =>
    Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n),
  );
}

function pinnedRun(
  store: Store,
  id = "run",
  ref = "main",
): Omit<RunRecord, "initialRevisionId" | "evaluation"> {
  const state = store.readState("p", ref);
  if (!state) throw new Error("Missing test state");
  return {
    id,
    projectId: "p",
    ref,
    status: "queued",
    outcome: null,
    instruction: "try options",
    revisionId: state.revisionId,
    baselineRevisionId: state.forkBase?.revisionId ?? null,
    briefVersion: state.brief.version,
    strategySeed: { seed: 5 },
    budget: { turns: 3 },
    retryCount: 0,
  };
}

describe("transactional commands", () => {
  it("replays a lost response after later ref and brief advancement, including canonical key order", () => {
    const store = storeAt();
    const first = change(create(store));
    const evaluator = vi.fn(evaluate);
    const original = accepted(store.execute(first, agent, evaluator));
    const later = accepted(
      store.execute(change(original.revisionId, "later"), agent, () => ({
        ok: true,
        model: { counter: 13 },
        effects: [{ after: 13 }],
      })),
    );
    accepted(
      store.execute(
        {
          type: "set_brief",
          projectId: "p",
          ref: "main",
          baseRevision: later.revisionId,
          requestId: "brief",
          body: { brief: { max: 30 }, baseBriefVersion: 1 },
        },
        owner,
      ),
    );
    const before = counts(store);
    expect(
      store.execute({ ...first, body: { nested: { a: 1, b: 2 }, amount: 3 } }, agent, evaluator),
    ).toEqual(original);
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(counts(store)).toEqual(before);
    expect(store.readState("p", "main")).toMatchObject({
      revisionId: later.revisionId,
      model: { counter: 13 },
      brief: { version: 2, body: { max: 30 } },
    });
    const persisted = store.db
      .prepare(
        "SELECT outcome, fingerprint, context FROM request_outcomes WHERE request_id = 'change'",
      )
      .get();
    expect(persisted?.outcome).toBe(JSON.stringify(original));
    expect(String(persisted?.fingerprint)).toHaveLength(64);
    expect(JSON.parse(String(persisted?.context))).toEqual({
      brief: { version: 1, body: { max: 20 } },
      forkBase: null,
    });
    expect(
      JSON.parse(
        String(
          store.db.prepare("SELECT change_set FROM revisions WHERE id = ?").get(original.revisionId)
            ?.change_set,
        ),
      ),
    ).toEqual({ body: first.body, effects: original.effects });
  });

  it("conflicts on changed payload, role, expected revision, ref, or command with the same scoped key", () => {
    const store = storeAt();
    const first = change(create(store));
    const result = accepted(store.execute(first, owner, evaluate));
    for (const modified of [
      { ...first, body: { amount: 4 } },
      { ...first, baseRevision: result.revisionId },
      { ...first, ref: "other" },
      { ...first, type: "set_brief" as const, body: { brief: { max: 50 }, baseBriefVersion: 1 } },
    ])
      expect(store.execute(modified, owner, evaluate)).toEqual({
        ok: false,
        code: "request_conflict",
      });
    expect(store.execute({ ...first, body: { amount: 4 } }, owner, evaluate)).toEqual({
      ok: false,
      code: "request_conflict",
    });
    expect(store.execute(first, { ...agent, role: "external" }, evaluate)).toEqual({
      ok: false,
      code: "request_conflict",
    });
    expect(store.readState("p", "main")?.revisionId).toBe(result.revisionId);
  });

  it("rejects a new stale competing base before evaluation or persisted model mutation", () => {
    const store = storeAt();
    const base = create(store);
    const first = accepted(store.execute(change(base), agent, evaluate));
    const competing = vi.fn(evaluate);
    expect(store.execute(change(base, "competing"), agent, competing)).toEqual({
      ok: false,
      code: "stale_base",
    });
    expect(competing).not.toHaveBeenCalled();
    expect(store.readState("p", "main")?.revisionId).toBe(first.revisionId);
    expect(counts(store)).toEqual([1, 1, 2, 1, 3]);
  });

  it("isolates project and credential namespaces instead of treating request IDs as global", () => {
    const store = storeAt();
    const a = create(store, "p");
    const b = create(store, "q");
    const p = accepted(store.execute(change(a), agent, evaluate));
    const q = accepted(store.execute(change(b, "change", "q"), agent, evaluate));
    const secondCredential = accepted(
      store.execute(change(p.revisionId), { role: "agent", namespace: "credential-b" }, evaluate),
    );
    expect(new Set([p.revisionId, q.revisionId, secondCredential.revisionId]).size).toBe(3);
    expect(store.execute(change(a), agent)).toEqual(p);
    expect(store.execute(change(b, "change", "q"), agent)).toEqual(q);
  });

  it("enforces owner-only metadata authorization before cached replay", () => {
    const store = storeAt();
    const createCommand: Command = {
      type: "create_project",
      projectId: "p",
      ref: "main",
      baseRevision: null,
      requestId: "create",
      body: { model: {}, brief: {} },
    };
    const base = accepted(store.execute(createCommand, owner)).revisionId;
    const commands: Command[] = [
      createCommand,
      {
        type: "fork_ref",
        projectId: "p",
        ref: "option",
        baseRevision: base,
        requestId: "fork",
        body: { sourceRef: "main" },
      },
      {
        type: "set_brief",
        projectId: "p",
        ref: "main",
        baseRevision: base,
        requestId: "brief",
        body: { brief: { n: 1 }, baseBriefVersion: 1 },
      },
    ];
    for (const command of commands) {
      accepted(store.execute(command, owner));
      const before = counts(store);
      expect(store.execute(command, agent)).toEqual({ ok: false, code: "forbidden" });
      expect(store.execute(command, { role: "external", namespace: "other" })).toEqual({
        ok: false,
        code: "forbidden",
      });
      expect(counts(store)).toEqual(before);
    }
  });

  it("uses the shared boundary for creation, forks and project-wide versioned briefs", () => {
    const store = storeAt();
    const base = create(store);
    const fork: Command = {
      type: "fork_ref",
      projectId: "p",
      ref: "option",
      baseRevision: base,
      requestId: "fork",
      body: { sourceRef: "main" },
    };
    const forked = accepted(store.execute(fork, owner));
    const changed = accepted(
      store.execute(change(base, "option-change", "p", "option"), agent, evaluate),
    );
    const brief: Command = {
      type: "set_brief",
      projectId: "p",
      ref: "option",
      baseRevision: changed.revisionId,
      requestId: "brief",
      body: { brief: { max: 40 }, baseBriefVersion: 1 },
    };
    const updated = accepted(store.execute(brief, owner));
    expect(updated).toEqual({
      ok: true,
      revisionId: changed.revisionId,
      briefVersion: 2,
      effects: [],
    });
    expect(store.execute(fork, owner)).toEqual(forked);
    expect(store.execute(brief, owner)).toEqual(updated);
    expect(store.readState("p", "option")).toMatchObject({
      model: { counter: 10 },
      forkBase: { revisionId: base, model: { counter: 7 } },
      brief: { version: 2, body: { max: 40 } },
    });
    expect(store.readState("p", "main")).toMatchObject({
      revisionId: base,
      brief: { version: 2, body: { max: 40 } },
    });
    expect(store.readSnapshot("p", base)).toEqual({ counter: 7 });
    expect(store.readBriefs("p")).toEqual([
      { version: 1, body: { max: 20 } },
      { version: 2, body: { max: 40 } },
    ]);
    expect(counts(store)).toEqual([1, 2, 2, 2, 4]);
  });

  it("rejects cross-project revision misuse both through the API and database ownership guards", () => {
    const store = storeAt();
    const a = create(store, "p");
    const b = create(store, "q");
    const evaluator = vi.fn(evaluate);
    expect(store.execute(change(b), agent, evaluator)).toEqual({ ok: false, code: "stale_base" });
    expect(evaluator).not.toHaveBeenCalled();
    expect(() => store.readSnapshot("p", b)).toThrow("Revision not found in project");
    expect(() => store.db.prepare("INSERT INTO refs VALUES ('p', 'bad', ?, NULL)").run(b)).toThrow(
      "another project",
    );
    expect(() => store.db.prepare("INSERT INTO refs VALUES ('p', 'bad', ?, ?)").run(a, b)).toThrow(
      "another project",
    );
    expect(() =>
      store.db.prepare("UPDATE refs SET head_revision_id = ? WHERE project_id = 'p'").run(b),
    ).toThrow("another project");
    expect(() =>
      store.db.prepare("INSERT INTO revisions VALUES ('bad', 'p', ?, '{}', '{}', 'now')").run(b),
    ).toThrow("another project");
    expect(() =>
      store.db.prepare("UPDATE revisions SET project_id = 'q' WHERE id = ?").run(a),
    ).toThrow();
  });

  it("does not cache evaluator exceptions and rolls back even a failure after model/ref writes", () => {
    const store = storeAt();
    const command = change(create(store));
    const before = counts(store);
    expect(() =>
      store.execute(command, agent, () => {
        throw new Error("transient");
      }),
    ).toThrow("transient");
    expect(counts(store)).toEqual(before);
    store.db.exec(
      "CREATE TRIGGER fail_outcome BEFORE INSERT ON request_outcomes BEGIN SELECT RAISE(ABORT, 'disk-like failure'); END;",
    );
    expect(() => store.execute(command, agent, evaluate)).toThrow("disk-like failure");
    expect(counts(store)).toEqual(before);
    expect(store.readState("p", "main")).toMatchObject({
      revisionId: command.baseRevision,
      model: { counter: 7 },
    });
    store.db.exec("DROP TRIGGER fail_outcome");
    accepted(store.execute(command, agent, evaluate));
  });

  it("persists deterministic rejection without changing the head, snapshots or model counters", () => {
    const store = storeAt();
    const command = change(create(store));
    const reject = vi.fn(() => ({
      ok: false as const,
      code: "budget",
      details: { used: 7, max: 6 },
    }));
    const result = store.execute(command, agent, reject);
    expect(result).toEqual({ ok: false, code: "budget", details: { used: 7, max: 6 } });
    expect(store.execute(command, agent, reject)).toEqual(result);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(store.readState("p", "main")).toMatchObject({
      revisionId: command.baseRevision,
      model: { counter: 7 },
    });
    expect(counts(store)).toEqual([1, 1, 1, 1, 2]);
  });

  it("bounds scopes and IDs before caching, and rejects non-JSON and asynchronous evaluations", () => {
    const store = storeAt();
    const command = change(create(store));
    const before = counts(store);
    expect(store.execute(command, { ...agent, namespace: "x".repeat(257) }, evaluate)).toEqual({
      ok: false,
      code: "invalid_caller",
    });
    expect(store.execute({ ...command, requestId: "x".repeat(129) }, agent, evaluate)).toEqual({
      ok: false,
      code: "invalid_command",
    });
    expect(() => store.execute({ ...command, body: { bad: Infinity } }, agent, evaluate)).toThrow(
      "JSON",
    );
    expect(() =>
      store.execute(command, agent, (() => Promise.resolve({ ok: true })) as never),
    ).toThrow("synchronous");
    expect(counts(store)).toEqual(before);
  });

  it("replays from another SQLite connection after closing the original response recipient", () => {
    const dir = mkdtempSync(join(tmpdir(), "or1-store-"));
    dirs.push(dir);
    const path = join(dir, "store.sqlite");
    const first = openStore(path);
    const command = change(create(first));
    const result = accepted(first.execute(command, agent, evaluate));
    first.close();
    const second = storeAt(path);
    accepted(second.execute(change(result.revisionId, "later"), agent, evaluate));
    expect(second.execute(command, agent)).toEqual(result);
  });
});

describe("metadata validation and brief preconditions", () => {
  it("caches creation rejection without a project and replays it after another credential creates it", () => {
    const store = storeAt();
    const command: Command = {
      type: "create_project",
      projectId: "p",
      ref: "main",
      baseRevision: null,
      requestId: "create",
      body: { model: { counter: 7 }, brief: { max: 20 } },
    };
    const reject = vi.fn((state) => {
      expect(state).toBeNull();
      expect(store.readBriefs("p")).toEqual([]);
      return { ok: false as const, code: "invalid_metadata", details: { field: "brief" } };
    });
    const result = store.execute(command, owner, undefined, reject);
    expect(result).toEqual({ ok: false, code: "invalid_metadata", details: { field: "brief" } });
    expect(counts(store)).toEqual([0, 0, 0, 0, 1]);
    expect(store.execute(command, agent, undefined, reject)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(store.execute(command, owner, undefined, reject)).toEqual(result);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(
      store.execute({ ...command, body: { model: {}, brief: {} } }, owner, undefined, reject),
    ).toEqual({ ok: false, code: "request_conflict" });
    accepted(store.execute(command, { ...owner, namespace: "other-credential" }));
    expect(store.execute(command, owner, undefined, reject)).toEqual(result);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(counts(store)).toEqual([1, 1, 1, 1, 2]);
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["fork_ref", "set_brief"] as const)(
    "validates %s against transactional state and caches rejection without metadata writes",
    (type) => {
      const store = storeAt();
      const base = create(store);
      const command: Command =
        type === "fork_ref"
          ? {
              type,
              projectId: "p",
              ref: "option",
              baseRevision: base,
              requestId: "metadata",
              body: { sourceRef: "main" },
            }
          : {
              type,
              projectId: "p",
              ref: "main",
              baseRevision: base,
              requestId: "metadata",
              body: { brief: { max: 30 }, baseBriefVersion: 1 },
            };
      const rejection = { ok: false as const, code: "requirement_id_reused" };
      const reject = vi.fn((state) => {
        expect(state).toEqual(store.readState("p", "main"));
        expect(store.readBriefs("p")).toEqual([{ version: 1, body: { max: 20 } }]);
        return rejection;
      });
      expect(store.execute(command, owner, undefined, reject)).toEqual(rejection);
      expect(counts(store)).toEqual([1, 1, 1, 1, 2]);
      accepted(store.execute(change(base), agent, evaluate));
      expect(store.execute(command, owner, undefined, reject)).toEqual(rejection);
      expect(reject).toHaveBeenCalledTimes(1);
      expect(store.readState("p", "option")).toBeNull();
      expect(store.readBriefs("p")).toEqual([{ version: 1, body: { max: 20 } }]);
    },
  );

  it.each(["create_project", "fork_ref", "set_brief"] as const)(
    "rolls back %s exceptions and failure after writes without consuming its request key",
    (type) => {
      const store = storeAt();
      const base = type === "create_project" ? null : create(store);
      const envelope = { projectId: "p", ref: "main", baseRevision: base, requestId: "metadata" };
      const command: Command =
        type === "create_project"
          ? { ...envelope, type, body: { model: {}, brief: {} } }
          : type === "fork_ref"
            ? { ...envelope, type, ref: "option", body: { sourceRef: "main" } }
            : { ...envelope, type, body: { brief: { max: 30 }, baseBriefVersion: 1 } };
      const before = counts(store);
      expect(() =>
        store.execute(command, owner, undefined, () => {
          throw new Error("validation failed transiently");
        }),
      ).toThrow("transiently");
      expect(() =>
        store.execute(command, owner, undefined, (() => Promise.resolve()) as never),
      ).toThrow("synchronous");
      expect(counts(store)).toEqual(before);
      store.db.exec(
        "CREATE TRIGGER fail_metadata_outcome BEFORE INSERT ON request_outcomes BEGIN SELECT RAISE(ABORT, 'metadata disk failure'); END;",
      );
      const validate = vi.fn(() => {});
      expect(() => store.execute(command, owner, undefined, validate)).toThrow(
        "metadata disk failure",
      );
      expect(counts(store)).toEqual(before);
      store.db.exec("DROP TRIGGER fail_metadata_outcome");
      const result = accepted(store.execute(command, owner, undefined, validate));
      expect(store.execute(command, owner, undefined, validate)).toEqual(result);
      expect(validate).toHaveBeenCalledTimes(2);
    },
  );

  it("locks metadata validation and rejects competing brief edits across connections and refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "or1-store-"));
    dirs.push(dir);
    const path = join(dir, "store.sqlite");
    const first = storeAt(path);
    const base = create(first);
    accepted(
      first.execute(
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
    const second = storeAt(path);
    second.db.exec("PRAGMA busy_timeout = 0");
    const command: Extract<Command, { type: "set_brief" }> = {
      type: "set_brief",
      projectId: "p",
      ref: "main",
      baseRevision: base,
      requestId: "brief-a",
      body: { brief: { max: 30 }, baseBriefVersion: 1 },
    };
    const competing = {
      ...command,
      ref: "option",
      requestId: "brief-b",
      body: { brief: { max: 50 }, baseBriefVersion: 1 },
    };
    const validate = vi.fn((state) => {
      expect(state?.brief).toEqual({ version: 1, body: { max: 20 } });
      expect(first.readBriefs("p")).toEqual([{ version: 1, body: { max: 20 } }]);
      // A validator outside BEGIN IMMEDIATE would let this second writer succeed.
      expect(() => second.execute(competing, owner)).toThrow("locked");
    });
    const result = accepted(first.execute(command, owner, undefined, validate));
    expect(result).toEqual({ ok: true, revisionId: base, briefVersion: 2, effects: [] });
    const staleValidator = vi.fn(() => {});
    expect(second.execute(competing, owner, undefined, staleValidator)).toEqual({
      ok: false,
      code: "stale_brief",
    });
    expect(staleValidator).not.toHaveBeenCalled();
    const rebased = {
      ...competing,
      requestId: "brief-c",
      body: { brief: { max: 50 }, baseBriefVersion: 2 },
    };
    accepted(second.execute(rebased, owner));
    const before = counts(first);
    expect(first.execute(command, owner, undefined, validate)).toEqual(result);
    expect(second.execute(competing, owner)).toEqual({ ok: false, code: "stale_brief" });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(counts(first)).toEqual(before);
    expect(
      first.execute({ ...command, body: { ...command.body, baseBriefVersion: 3 } }, owner),
    ).toEqual({ ok: false, code: "request_conflict" });
    expect(first.readBriefs("p")).toEqual([
      { version: 1, body: { max: 20 } },
      { version: 2, body: { max: 30 } },
      { version: 3, body: { max: 50 } },
    ]);
    expect(first.readState("p", "main")?.revisionId).toBe(base);
    expect(first.readState("p", "option")?.revisionId).toBe(base);
  });

  it("checks head and brief preconditions before validation and caches missing-project rejection", () => {
    const store = storeAt();
    const missing = change("missing");
    const result = store.execute(missing, agent, evaluate);
    expect(result).toEqual({ ok: false, code: "project_not_found" });
    const base = create(store);
    expect(store.execute(missing, agent, evaluate)).toEqual(result);
    const command: Command = {
      type: "set_brief",
      projectId: "p",
      ref: "main",
      baseRevision: "missing",
      requestId: "brief",
      body: { brief: {}, baseBriefVersion: 1 },
    };
    const validate = vi.fn(() => {});
    expect(store.execute(command, owner, undefined, validate)).toEqual({
      ok: false,
      code: "stale_base",
    });
    for (const baseBriefVersion of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        store.execute(
          { ...command, baseRevision: base, body: { brief: {}, baseBriefVersion } },
          owner,
          undefined,
          validate,
        ),
      ).toEqual({ ok: false, code: "invalid_command" });
    }
    expect(validate).not.toHaveBeenCalled();
  });
});

describe("legacy migration and run persistence", () => {
  it.each([0, 1])(
    "version-migrates legacy schema version %i, preserving exact historical content",
    (version) => {
      const dir = mkdtempSync(join(tmpdir(), "or1-store-"));
      dirs.push(dir);
      const path = join(dir, "legacy.sqlite");
      const legacy = new DatabaseSync(path);
      legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE revisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), parent_id TEXT REFERENCES revisions(id), change_set TEXT NOT NULL, snapshot TEXT, created_at TEXT NOT NULL);
      CREATE TABLE refs (project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, head_revision_id TEXT NOT NULL REFERENCES revisions(id), fork_base_revision_id TEXT REFERENCES revisions(id), PRIMARY KEY(project_id, name));
      CREATE TABLE briefs (project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id, version));
      CREATE TABLE request_outcomes (request_id TEXT PRIMARY KEY, revision_id TEXT REFERENCES revisions(id), outcome TEXT NOT NULL);
      CREATE TABLE redlines (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), ref TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued', 'delivered', 'applied')), body TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), ref TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'failed', 'cancelled', 'interrupted')), outcome TEXT CHECK(outcome IN ('options', 'infeasible', 'not_found_within_budget')), instruction TEXT NOT NULL, brief_version INTEGER NOT NULL, strategy_seed TEXT, budget TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE run_turns (run_id TEXT NOT NULL REFERENCES runs(id), turn INTEGER NOT NULL, transcript TEXT NOT NULL, spend TEXT NOT NULL, PRIMARY KEY(run_id, turn));
      INSERT INTO projects VALUES ('p', 'old');
      INSERT INTO revisions VALUES ('r-old', 'p', NULL, '[1]', '{ "version": 1, "counter": 9 }', 'old');
      INSERT INTO refs VALUES ('p', 'main', 'r-old', NULL);
      INSERT INTO refs VALUES ('p', 'option', 'r-old', 'r-old');
      INSERT INTO briefs VALUES ('p', 1, '{ "version": 1, "title": "legacy" }');
      INSERT INTO request_outcomes VALUES ('change', 'r-old', '{ "legacy": true }');
      INSERT INTO request_outcomes VALUES ('rejected', NULL, '{ "ok": false }');
      INSERT INTO runs VALUES ('old-run', 'p', 'main', 'done', 'infeasible', 'legacy instruction', 1, NULL, '{}', 0);
      INSERT INTO run_turns VALUES ('old-run', 1, '["legacy"]', '{ "usd": 2 }');
      PRAGMA user_version = ${version};
    `);
      legacy.close();
      const store = storeAt(path);
      expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
      expect(
        store.db.prepare("SELECT snapshot, change_set, created_at FROM revisions").get(),
      ).toMatchObject({
        snapshot: '{ "version": 1, "counter": 9 }',
        change_set: "[1]",
        created_at: "old",
      });
      expect(store.db.prepare("SELECT body FROM briefs").get()?.body).toBe(
        '{ "version": 1, "title": "legacy" }',
      );
      expect(
        store.db
          .prepare(
            "SELECT request_id, revision_id, outcome FROM request_outcomes WHERE project_id IS NULL ORDER BY request_id",
          )
          .all(),
      ).toEqual([
        { request_id: "change", revision_id: "r-old", outcome: '{ "legacy": true }' },
        { request_id: "rejected", revision_id: null, outcome: '{ "ok": false }' },
      ]);
      expect(store.readState("p", "option")).toMatchObject({
        forkBase: { revisionId: "r-old", model: { version: 1, counter: 9 } },
        brief: { version: 1, body: { version: 1, title: "legacy" } },
      });
      expect(store.readRun("old-run")).toMatchObject({
        revisionId: null,
        initialRevisionId: null,
        evaluation: null,
        baselineRevisionId: null,
        outcome: "infeasible",
      });
      expect(store.readRunTurns("old-run")).toEqual([
        { runId: "old-run", turn: 1, transcript: ["legacy"], result: null, spend: { usd: 2 } },
      ]);
      expect(store.finalizeRun("old-run", "infeasible")).toEqual({ ok: false, code: "stale_run" });
      accepted(store.execute(change("r-old"), agent, evaluate));
      expect(
        store.db.prepare("SELECT snapshot FROM revisions WHERE id = 'r-old'").get()?.snapshot,
      ).toBe('{ "version": 1, "counter": 9 }');
      expect(
        store.db
          .prepare("SELECT count(*) AS n FROM request_outcomes WHERE request_id = 'change'")
          .get()?.n,
      ).toBe(2);
      const reopened = storeAt(path);
      expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
      expect(reopened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );

  it("persists pinned runs and ordered turns without server table writes", () => {
    const store = storeAt();
    const base = create(store);
    const run = pinnedRun(store);
    store.createRun(run);
    accepted(
      store.execute(
        {
          type: "set_brief",
          projectId: "p",
          ref: "main",
          baseRevision: base,
          requestId: "brief",
          body: { brief: { max: 40 }, baseBriefVersion: 1 },
        },
        owner,
      ),
    );
    store.updateRun("run", { status: "running", retryCount: 1 });
    expect(store.readRun("run")).toEqual({
      ...run,
      initialRevisionId: base,
      evaluation: null,
      status: "running",
      retryCount: 1,
    });
    store.saveRunTurn({
      runId: "run",
      turn: 2,
      transcript: ["second"],
      result: { accepted: true },
      spend: { usd: 0.25 },
    });
    store.saveRunTurn({
      runId: "run",
      turn: 1,
      transcript: ["first"],
      result: { accepted: false },
      spend: { usd: 0.1 },
    });
    expect(() =>
      store.saveRunTurn({
        runId: "run",
        turn: 1,
        transcript: ["replacement"],
        result: null,
        spend: null,
      }),
    ).toThrow("UNIQUE");
    expect(store.readRunTurns("run")).toEqual([
      {
        runId: "run",
        turn: 1,
        transcript: ["first"],
        result: { accepted: false },
        spend: { usd: 0.1 },
      },
      {
        runId: "run",
        turn: 2,
        transcript: ["second"],
        result: { accepted: true },
        spend: { usd: 0.25 },
      },
    ]);
    expect(() => store.createRun({ ...run, id: "bad", briefVersion: 99 })).toThrow("brief version");
    expect(() => store.createRun({ ...run, id: "bad", ref: "absent" })).toThrow("ref not found");
    expect(() =>
      store.saveRunTurn({ runId: "absent", turn: 1, transcript: [], result: null, spend: {} }),
    ).toThrow();
    expect(store.readRun("bad")).toBeNull();
  });

  it("finalizes only while the pinned ref, brief and main fork baseline are current", () => {
    for (const stale of ["ref", "brief", "main"] as const) {
      const store = storeAt();
      const base = create(store);
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
      const run = pinnedRun(store, "run", "option");
      store.createRun(run);
      store.updateRun("run", { status: "running" });
      if (stale === "brief") {
        accepted(
          store.execute(
            {
              type: "set_brief",
              projectId: "p",
              ref: "main",
              baseRevision: base,
              requestId: "brief",
              body: { brief: { max: 40 }, baseBriefVersion: 1 },
            },
            owner,
          ),
        );
      } else {
        accepted(
          store.execute(
            change(base, "advance", "p", stale === "main" ? "main" : "option"),
            agent,
            evaluate,
          ),
        );
      }
      expect(store.finalizeRun("run", "options")).toEqual({ ok: false, code: "stale_run" });
      expect(store.readRun("run")).toMatchObject({ status: "running", outcome: null });
      expect(() => store.createRun({ ...run, id: "bad" })).toThrow("stale");
    }
    const store = storeAt();
    const base = create(store);
    store.createRun(pinnedRun(store));
    const evaluation = {
      revisionId: base,
      briefVersion: 1,
      baselineRevisionId: null,
      evaluatorVersion: "test-v1",
      result: { score: 3 },
    };
    const result = store.finalizeRun("run", "infeasible", evaluation);
    expect(result).toEqual({ ok: true, revisionId: base, briefVersion: 1, effects: [] });
    expect(store.readRun("run")).toMatchObject({ status: "done", outcome: "infeasible" });
    expect(store.finalizeRun("run", "infeasible", evaluation)).toEqual(result);
    expect(store.finalizeRun("run", "options")).toEqual({ ok: false, code: "run_finished" });
    expect(() => store.updateRun("run", { status: "running" })).toThrow("finished");
  });

  it("bounds turn bytes across transcript, result and spend, and rolls back failed finalization", () => {
    const store = storeAt();
    const base = create(store);
    store.createRun(pinnedRun(store));
    // JSON quotes plus two null values add exactly 10 bytes.
    store.saveRunTurn({
      runId: "run",
      turn: 0,
      transcript: "x".repeat(MAX_RUN_TURN_BYTES - 10),
      result: null,
      spend: null,
    });
    expect(() =>
      store.saveRunTurn({
        runId: "run",
        turn: 1,
        transcript: "x".repeat(MAX_RUN_TURN_BYTES - 9),
        result: null,
        spend: null,
      }),
    ).toThrow("byte limit");
    expect(() =>
      store.saveRunTurn({
        runId: "run",
        turn: 2,
        transcript: null,
        result: "é".repeat(MAX_RUN_TURN_BYTES / 2),
        spend: null,
      }),
    ).toThrow("byte limit");
    expect(store.readRunTurns("run")).toHaveLength(1);
    store.db.exec(
      "CREATE TRIGGER fail_finalize BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'finalize failure'); END;",
    );
    const evaluation = {
      revisionId: base,
      briefVersion: 1,
      baselineRevisionId: null,
      evaluatorVersion: "test-v1",
      result: { score: 3 },
    };
    expect(() => store.finalizeRun("run", "options", evaluation)).toThrow("finalize failure");
    expect(store.readRun("run")).toMatchObject({ status: "queued", outcome: null });
    store.db.exec("DROP TRIGGER fail_finalize");
    accepted(store.finalizeRun("run", "options", evaluation));
  });
});
