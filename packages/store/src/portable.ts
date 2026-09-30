import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

/** The engine stores only SQLite text, finite numbers and null, never blobs or bigint. */
export type SqlBinding = string | number | null;
export type SqlRow = Record<string, SqlBinding>;
export type SqlStatement = {
  get(...bindings: SqlBinding[]): SqlRow | undefined;
  all(...bindings: SqlBinding[]): SqlRow[];
  run(...bindings: SqlBinding[]): { changes: number };
};
/** Synchronous, eagerly materialized SQL. Drivers enable foreign keys before initialization.
 * Transactions commit on return and roll back on throw, including schema-version writes.
 * Read transactions provide a coherent snapshot without reserving a write lock where supported;
 * write transactions serialize writers. Callbacks must not return promises or escape cursors.
 */
export type SqlDriver = {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  transaction<T>(callback: () => T, mode: "read" | "write"): T;
  getSchemaVersion(): number;
  setSchemaVersion(version: number): void;
  close(): void;
};

/** Version 1 is kept intact as the starting point for new and legacy databases. */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_id TEXT REFERENCES revisions(id),
  change_set TEXT NOT NULL,
  snapshot TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refs (
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  head_revision_id TEXT NOT NULL REFERENCES revisions(id),
  fork_base_revision_id TEXT REFERENCES revisions(id),
  PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS briefs (
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (project_id, version)
);
CREATE TABLE IF NOT EXISTS redlines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'applied')),
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled', 'interrupted')),
  outcome TEXT CHECK (outcome IN ('options', 'infeasible', 'not_found_within_budget')),
  instruction TEXT NOT NULL,
  brief_version INTEGER NOT NULL,
  strategy_seed TEXT,
  budget TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS run_turns (
  run_id TEXT NOT NULL REFERENCES runs(id),
  turn INTEGER NOT NULL,
  transcript TEXT NOT NULL,
  spend TEXT NOT NULL,
  PRIMARY KEY (run_id, turn)
);
CREATE TABLE IF NOT EXISTS request_outcomes (
  request_id TEXT PRIMARY KEY,
  revision_id TEXT REFERENCES revisions(id),
  outcome TEXT NOT NULL
);
`;

export type PortableStore = {
  execute(
    command: AcceptanceCommand,
    caller: Caller,
    evaluate?: AcceptanceEvaluator,
  ): AcceptanceResult;
  execute(
    command: Exclude<Command, AcceptanceCommand>,
    caller: Caller,
    evaluate?: Evaluator,
    validateMetadata?: MetadataValidator,
  ): CommandResult;
  readReview(
    projectId: string,
    sourceRef: string,
  ): { ok: true; states: AcceptanceStates } | Rejection;
  readState(projectId: string, ref: string): RefState | null;
  readSnapshot(projectId: string, revisionId: string): unknown;
  readBriefs(projectId: string): RefState["brief"][];
  createRun(run: Omit<RunRecord, "initialRevisionId" | "evaluation">): void;
  updateRun(id: string, patch: RunPatch): void;
  finalizeRun(
    id: string,
    outcome: NonNullable<RunRecord["outcome"]>,
    evaluation?: RunEvaluation,
  ): CommandResult;
  interruptRunningRuns(): number;
  readRun(id: string): RunRecord | null;
  saveRunTurn(turn: RunTurn): void;
  readRunTurns(runId: string): RunTurn[];
  /** Latest persisted turn of a run (its cumulative spend), or null before the first turn. */
  readLastRunTurn(runId: string): RunTurn | null;
  /** Read-only listings for owner navigation; they never grant access by themselves. */
  listProjects(): ProjectSummary[];
  listRefs(projectId: string): RefSummary[];
  /** Runs of a project in creation order. */
  listRuns(projectId: string): RunRecord[];
  close(): void;
};

export type ProjectSummary = { projectId: string; createdAt: string };
export type RefSummary = { ref: string; revisionId: string; forkBaseRevisionId: string | null };

export type Caller = {
  role: "owner" | "agent" | "external";
  namespace: string;
  /** Trusted workflow binding, never accepted from tool arguments. */
  runId?: string;
};
type Envelope = { projectId: string; ref: string; baseRevision: string | null; requestId: string };
/** The registry supplies core validation through validateMetadata/evaluate (core stays independent).
 * For fork_ref, ref is the new target name and baseRevision is the sourceRef's expected head.
 * apply_changes body is the canonical core command, including any caller-supplied context pins.
 */
export type Command =
  | (Envelope &
      (
        | { type: "create_project"; body: { model: unknown; brief: unknown } }
        | { type: "fork_ref"; body: { sourceRef: string } }
        | { type: "set_brief"; body: { brief: unknown; baseBriefVersion: number } }
        | { type: "apply_changes"; body: unknown }
      ))
  | AcceptanceCommand;
export type AcceptanceCommand = {
  type: "accept_option";
  projectId: string;
  ref: "main";
  baseRevision: string;
  requestId: string;
  body: {
    sourceRef: string;
    sourceRevisionId: string;
    briefVersion: number;
    baselineRevisionId: string;
    evaluatorVersion: string;
  };
};
export type Rejection = { ok: false; code: string; message?: string; details?: unknown };
export type CommandResult =
  | {
      ok: true;
      revisionId: string;
      briefVersion: number;
      effects: unknown;
      acceptance?: AcceptanceReceipt;
    }
  | Rejection;
export type AcceptanceReceipt = AcceptanceCommand["body"] & {
  schemaVersion: 1;
  projectId: string;
  previousMainRevisionId: string;
  requestId: string;
  actor: { role: "owner"; namespace: string };
  scorecard: unknown;
};
export type AcceptanceResult =
  | (Extract<CommandResult, { ok: true }> & { acceptance: AcceptanceReceipt; effects: [] })
  | Rejection;
export type RefState = {
  projectId: string;
  ref: string;
  revisionId: string;
  model: unknown;
  brief: { version: number; body: unknown };
  forkBase: { revisionId: string; model: unknown } | null;
};
export type Evaluation = { ok: true; model: unknown; effects: unknown } | Rejection;
/** Must be synchronous and side-effect free; an exception rolls back without caching an outcome. */
export type Evaluator = (state: RefState) => Evaluation;
export type AcceptanceStates = { main: RefState; source: RefState };
/** Core semantics belong to the registry. The store promotes the unchanged source snapshot only. */
export type AcceptanceEvaluator = (
  states: AcceptanceStates,
) => { ok: true; evaluation: { evaluatorVersion: string; result: unknown } } | Rejection;
/** Runs inside the write transaction after preconditions and before metadata writes, never on replay.
 * State is null for creation, the source ref for fork_ref, and the target ref for set_brief.
 * May read store.readBriefs for lineage checks; must be synchronous and otherwise side-effect free.
 * Return void to accept or a deterministic rejection to cache; exceptions roll back uncached.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: acceptance deliberately permits callbacks with no return.
export type MetadataValidator = (state: RefState | null) => Rejection | void;
export type RunRecord = {
  id: string;
  projectId: string;
  ref: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";
  outcome: "options" | "infeasible" | "not_found_within_budget" | null;
  instruction: string;
  /** Mutable cursor; null only for historical v1 runs, which cannot be finalized. */
  revisionId: string | null;
  /** Derived at creation, immutable; historical missing provenance stays null. */
  readonly initialRevisionId: string | null;
  baselineRevisionId: string | null;
  briefVersion: number;
  strategySeed: unknown;
  budget: unknown;
  retryCount: number;
  evaluation: RunEvaluation | null;
};
export type RunEvaluation = {
  revisionId: string;
  briefVersion: number;
  baselineRevisionId: string | null;
  evaluatorVersion: string;
  result: unknown;
};
export type RunPatch = {
  status?: Exclude<RunRecord["status"], "done">;
  retryCount?: number;
};
export type RunTurn = {
  runId: string;
  turn: number;
  transcript: unknown;
  result: unknown;
  spend: unknown;
};
/** Maximum UTF-8 bytes of a turn's combined canonical transcript/result/spend JSON. */
export const MAX_RUN_TURN_BYTES = 65_536;
/** Maximum UTF-8 bytes of the complete canonical final evaluation JSON. */
export const MAX_RUN_EVALUATION_BYTES = 65_536;
/** Maximum UTF-8 bytes of the complete canonical acceptance receipt JSON. */
export const MAX_ACCEPTANCE_RECEIPT_BYTES = 65_536;

function transaction<T>(db: SqlDriver, action: () => T, mode: "read" | "write" = "write"): T {
  return db.transaction(action, mode);
}

function migrate(db: SqlDriver): void {
  transaction(db, () => {
    const version = db.getSchemaVersion();
    if (version > 3) throw new Error(`Unsupported store schema version ${version}`);
    if (version < 1) {
      db.exec(SCHEMA_V1);
      db.setSchemaVersion(1);
    }
    if (version < 2) {
      db.exec(`
        ALTER TABLE request_outcomes RENAME TO request_outcomes_v1;
        CREATE TABLE request_outcomes (
          id INTEGER PRIMARY KEY,
          project_id TEXT,
          namespace TEXT,
          request_id TEXT NOT NULL,
          role TEXT,
          fingerprint TEXT,
          context TEXT,
          revision_id TEXT REFERENCES revisions(id),
          outcome TEXT NOT NULL,
          UNIQUE (project_id, namespace, request_id),
          CHECK ((project_id IS NULL AND namespace IS NULL AND role IS NULL
                  AND fingerprint IS NULL AND context IS NULL)
            OR (project_id IS NOT NULL AND namespace IS NOT NULL
                  AND role IS NOT NULL AND role IN ('owner', 'agent', 'external') AND fingerprint IS NOT NULL
                  AND context IS NOT NULL AND length(project_id) BETWEEN 1 AND 128
                  AND length(namespace) BETWEEN 1 AND 256 AND length(request_id) BETWEEN 1 AND 128
                  AND length(fingerprint) = 64))
        );
        INSERT INTO request_outcomes (request_id, revision_id, outcome)
          SELECT request_id, revision_id, outcome FROM request_outcomes_v1;
        DROP TABLE request_outcomes_v1;
        CREATE UNIQUE INDEX legacy_request_ids ON request_outcomes(request_id)
          WHERE project_id IS NULL;
        ALTER TABLE runs ADD COLUMN revision_id TEXT REFERENCES revisions(id);
        ALTER TABLE runs ADD COLUMN baseline_revision_id TEXT REFERENCES revisions(id);
        ALTER TABLE run_turns ADD COLUMN result TEXT;
      `);
      // Individual foreign keys do not guarantee that revisions belong to the same project.
      // Validate historical rows before adding guards, without modifying any historical content.
      const invalid = db
        .prepare(`
        SELECT 1 FROM revisions r JOIN revisions p ON p.id = r.parent_id
          WHERE r.project_id != p.project_id
        UNION ALL
        SELECT 1 FROM refs f JOIN revisions r ON r.id = f.head_revision_id
          WHERE f.project_id != r.project_id
        UNION ALL
        SELECT 1 FROM refs f JOIN revisions r ON r.id = f.fork_base_revision_id
          WHERE f.project_id != r.project_id LIMIT 1
      `)
        .get();
      if (invalid) throw new Error("Legacy database contains cross-project revision references");
      for (const operation of ["INSERT", "UPDATE"] as const) {
        db.exec(`
          CREATE TRIGGER revision_project_${operation.toLowerCase()} BEFORE ${operation} ON revisions
          WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM revisions WHERE id = NEW.parent_id AND project_id = NEW.project_id)
          BEGIN SELECT RAISE(ABORT, 'Revision parent belongs to another project'); END;
          CREATE TRIGGER ref_project_${operation.toLowerCase()} BEFORE ${operation} ON refs
          WHEN NOT EXISTS (
            SELECT 1 FROM revisions WHERE id = NEW.head_revision_id AND project_id = NEW.project_id)
            OR (NEW.fork_base_revision_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM revisions WHERE id = NEW.fork_base_revision_id AND project_id = NEW.project_id))
          BEGIN SELECT RAISE(ABORT, 'Ref revision belongs to another project'); END;
          CREATE TRIGGER outcome_project_${operation.toLowerCase()} BEFORE ${operation} ON request_outcomes
          WHEN NEW.project_id IS NOT NULL AND NEW.revision_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM revisions WHERE id = NEW.revision_id AND project_id = NEW.project_id)
          BEGIN SELECT RAISE(ABORT, 'Outcome revision belongs to another project'); END;
          CREATE TRIGGER run_project_${operation.toLowerCase()} BEFORE ${operation} ON runs
          WHEN (NEW.revision_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM revisions WHERE id = NEW.revision_id AND project_id = NEW.project_id))
            OR (NEW.baseline_revision_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM revisions WHERE id = NEW.baseline_revision_id AND project_id = NEW.project_id))
          BEGIN SELECT RAISE(ABORT, 'Run revision belongs to another project'); END;
        `);
      }
      db.exec(`
        CREATE TRIGGER immutable_revision BEFORE UPDATE ON revisions
          BEGIN SELECT RAISE(ABORT, 'Revisions are immutable'); END;
        CREATE TRIGGER immutable_fork_base BEFORE UPDATE OF fork_base_revision_id ON refs
          WHEN OLD.fork_base_revision_id IS NOT NEW.fork_base_revision_id
          BEGIN SELECT RAISE(ABORT, 'Fork baseline is immutable'); END;
        CREATE TRIGGER immutable_brief BEFORE UPDATE ON briefs
          BEGIN SELECT RAISE(ABORT, 'Brief versions are immutable'); END;
      `);
      db.setSchemaVersion(2);
    }
    if (version < 3) {
      db.exec(`
        ALTER TABLE runs ADD COLUMN initial_revision_id TEXT REFERENCES revisions(id);
        ALTER TABLE runs ADD COLUMN evaluation TEXT;
        UPDATE runs SET initial_revision_id = revision_id;
        CREATE TRIGGER immutable_run_pins BEFORE UPDATE ON runs
          WHEN OLD.initial_revision_id IS NOT NEW.initial_revision_id
            OR OLD.project_id IS NOT NEW.project_id OR OLD.ref IS NOT NEW.ref
            OR OLD.brief_version IS NOT NEW.brief_version
            OR OLD.baseline_revision_id IS NOT NEW.baseline_revision_id
          BEGIN SELECT RAISE(ABORT, 'Run provenance and context pins are immutable'); END;
        CREATE TRIGGER initial_run_project BEFORE INSERT ON runs
          WHEN NEW.initial_revision_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM revisions WHERE id = NEW.initial_revision_id AND project_id = NEW.project_id)
          BEGIN SELECT RAISE(ABORT, 'Initial run revision belongs to another project'); END;
      `);
      db.setSchemaVersion(3);
    }
  });
}

/** Sorted, strict JSON, shared by persistence and command fingerprints. */
function json(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${json(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Store values must be finite JSON data");
}

function bounded(value: unknown, max = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}

/** Initialize the shared engine and take ownership of the driver, closing it on init failure. */
function runTurn(row: SqlRow): RunTurn {
  return {
    runId: String(row.run_id),
    turn: Number(row.turn),
    transcript: JSON.parse(String(row.transcript)),
    result: row.result === null ? null : JSON.parse(String(row.result)),
    spend: JSON.parse(String(row.spend)),
  };
}

export function createStore(db: SqlDriver): PortableStore {
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  function readSnapshot(projectId: string, revisionId: string): unknown {
    const row = db
      .prepare("SELECT snapshot FROM revisions WHERE project_id = ? AND id = ?")
      .get(projectId, revisionId);
    if (!row) throw new Error("Revision not found in project");
    return row.snapshot === null ? null : JSON.parse(String(row.snapshot));
  }

  function readState(projectId: string, ref: string): RefState | null {
    const row = db
      .prepare(`
        SELECT f.head_revision_id, f.fork_base_revision_id, r.snapshot,
          base.snapshot AS base_snapshot, b.version AS brief_version, b.body AS brief_body
        FROM refs f JOIN revisions r ON r.id = f.head_revision_id AND r.project_id = f.project_id
        LEFT JOIN revisions base ON base.id = f.fork_base_revision_id AND base.project_id = f.project_id
        LEFT JOIN briefs b ON b.project_id = f.project_id AND b.version = (
          SELECT max(version) FROM briefs WHERE project_id = f.project_id)
        WHERE f.project_id = ? AND f.name = ?
      `)
      .get(projectId, ref);
    if (!row) return null;
    const revisionId = String(row.head_revision_id);
    return {
      projectId,
      ref,
      revisionId,
      model: row.snapshot === null ? null : JSON.parse(String(row.snapshot)),
      brief:
        row.brief_version === null
          ? { version: 0, body: null }
          : { version: Number(row.brief_version), body: JSON.parse(String(row.brief_body)) },
      forkBase:
        row.fork_base_revision_id === null
          ? null
          : {
              revisionId: String(row.fork_base_revision_id),
              model: row.base_snapshot === null ? null : JSON.parse(String(row.base_snapshot)),
            },
    };
  }

  function reviewStates(
    projectId: string,
    sourceRef: string,
  ): { ok: true; states: AcceptanceStates } | Rejection {
    if (sourceRef === "main") return { ok: false, code: "invalid_ref" };
    const main = readState(projectId, "main");
    const source = readState(projectId, sourceRef);
    if (!main || !source) return { ok: false, code: "ref_not_found" };
    if (!source.forkBase) return { ok: false, code: "invalid_ref" };
    return { ok: true, states: { main, source } };
  }

  function execute(
    command: AcceptanceCommand,
    caller: Caller,
    evaluate?: AcceptanceEvaluator,
  ): AcceptanceResult;
  function execute(
    command: Exclude<Command, AcceptanceCommand>,
    caller: Caller,
    evaluate?: Evaluator,
    validateMetadata?: MetadataValidator,
  ): CommandResult;
  function execute(
    command: Command,
    caller: Caller,
    evaluate?: Evaluator | AcceptanceEvaluator,
    validateMetadata?: MetadataValidator,
  ): CommandResult {
    if (
      !bounded(caller.namespace, 256) ||
      !["owner", "agent", "external"].includes(caller.role) ||
      (caller.runId !== undefined && !bounded(caller.runId))
    ) {
      return { ok: false, code: "invalid_caller" };
    }
    if (
      !["create_project", "fork_ref", "set_brief", "apply_changes", "accept_option"].includes(
        command.type,
      ) ||
      !bounded(command.projectId) ||
      !bounded(command.ref) ||
      !bounded(command.requestId) ||
      (command.type === "fork_ref" && !bounded(command.body.sourceRef)) ||
      (command.type === "set_brief" &&
        (!Number.isSafeInteger(command.body.baseBriefVersion) ||
          command.body.baseBriefVersion < 0)) ||
      (command.type === "accept_option" &&
        (!bounded(command.baseRevision) ||
          !bounded(command.body.sourceRef) ||
          !bounded(command.body.sourceRevisionId) ||
          !bounded(command.body.baselineRevisionId) ||
          !bounded(command.body.evaluatorVersion) ||
          !Number.isSafeInteger(command.body.briefVersion) ||
          command.body.briefVersion < 0)) ||
      (command.baseRevision !== null && !bounded(command.baseRevision))
    ) {
      return { ok: false, code: "invalid_command" };
    }
    // Caller context must come from the authenticated registry, never command arguments.
    // Authorization precedes cached replay, including a cached owner success.
    if ((command.type !== "apply_changes" || command.ref === "main") && caller.role !== "owner")
      return { ok: false, code: "forbidden" };
    const commandJson = json(command);
    return transaction(db, () => {
      // Authenticate immutable binding before replay, but never require a historical retry's
      // cursor/status to still be current. The registry alone supplies the trusted run ID.
      const run = caller.runId === undefined ? null : readRun(caller.runId);
      if (
        caller.runId !== undefined &&
        (command.type !== "apply_changes" ||
          !run ||
          run.projectId !== command.projectId ||
          run.ref !== command.ref)
      )
        return { ok: false, code: "invalid_run_binding" };
      const previous = db
        .prepare(
          "SELECT fingerprint, context, outcome FROM request_outcomes WHERE project_id = ? AND namespace = ? AND request_id = ?",
        )
        .get(command.projectId, caller.namespace, command.requestId);
      const projectExists = Boolean(
        db.prepare("SELECT 1 FROM projects WHERE id = ?").get(command.projectId),
      );
      const state = previous
        ? null
        : readState(
            command.projectId,
            command.type === "fork_ref" ? command.body.sourceRef : command.ref,
          );
      const context = previous
        ? String(previous.context)
        : json({ brief: state?.brief ?? null, forkBase: state?.forkBase ?? null });
      const fingerprint = createHash("sha256")
        .update(
          json({
            command: JSON.parse(commandJson),
            role: caller.role,
            // Omit absent binding to preserve v2 unbound request fingerprints exactly.
            ...(caller.runId === undefined ? {} : { runId: caller.runId }),
            context: JSON.parse(context),
          }),
        )
        .digest("hex");
      if (previous) {
        if (previous.fingerprint !== fingerprint) return { ok: false, code: "request_conflict" };
        return JSON.parse(String(previous.outcome)) as CommandResult;
      }

      const persist = (result: CommandResult): CommandResult => {
        const outcome = json(result);
        // Rejected creation/missing-project commands also own a key, without creating a project.
        db.prepare(
          "INSERT INTO request_outcomes (project_id, namespace, request_id, role, fingerprint, context, revision_id, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          command.projectId,
          caller.namespace,
          command.requestId,
          caller.role,
          fingerprint,
          context,
          result.ok ? result.revisionId : null,
          outcome,
        );
        // First response and replay have exactly the same serialized representation.
        return JSON.parse(outcome) as CommandResult;
      };
      const validate = (state: RefState | null) => {
        const rejection = validateMetadata?.(state);
        if (rejection !== undefined && rejection?.ok !== false)
          throw new Error("Metadata validator must return a synchronous rejection or void");
        return rejection;
      };
      if (command.type === "create_project") {
        if (command.baseRevision !== null) return persist({ ok: false, code: "invalid_base" });
        if (projectExists) return persist({ ok: false, code: "project_exists" });
        const rejection = validate(null);
        if (rejection) return persist(rejection);
        const snapshot = json(command.body.model);
        const brief = json(command.body.brief);
        const revisionId = randomUUID();
        const now = new Date().toISOString();
        db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
          command.projectId,
          now,
        );
        db.prepare(
          "INSERT INTO revisions (id, project_id, parent_id, change_set, snapshot, created_at) VALUES (?, ?, NULL, ?, ?, ?)",
        ).run(revisionId, command.projectId, commandJson, snapshot, now);
        db.prepare("INSERT INTO refs (project_id, name, head_revision_id) VALUES (?, ?, ?)").run(
          command.projectId,
          command.ref,
          revisionId,
        );
        db.prepare("INSERT INTO briefs (project_id, version, body) VALUES (?, 1, ?)").run(
          command.projectId,
          brief,
        );
        return persist({ ok: true, revisionId, briefVersion: 1, effects: [] });
      }
      if (!projectExists) return persist({ ok: false, code: "project_not_found" });
      if (command.type === "accept_option") {
        if (command.ref !== "main") return persist({ ok: false, code: "invalid_ref" });
        const review = reviewStates(command.projectId, command.body.sourceRef);
        if (!review.ok) return persist(review);
        const { main, source } = review.states;
        if (command.baseRevision !== main.revisionId)
          return persist({ ok: false, code: "stale_base" });
        if (command.body.sourceRevisionId !== source.revisionId)
          return persist({ ok: false, code: "stale_source" });
        if (command.body.briefVersion !== main.brief.version)
          return persist({ ok: false, code: "stale_brief" });
        if (
          command.body.baselineRevisionId !== source.forkBase?.revisionId ||
          command.body.baselineRevisionId !== command.baseRevision ||
          command.body.baselineRevisionId !== main.revisionId
        )
          return persist({ ok: false, code: "stale_baseline" });
        if (!evaluate) throw new Error("accept_option requires a synchronous evaluator");
        const candidate = (evaluate as AcceptanceEvaluator)(review.states);
        if (
          !candidate ||
          Object.getPrototypeOf(candidate) !== Object.prototype ||
          (candidate.ok !== true && candidate.ok !== false) ||
          (candidate.ok === false &&
            (!bounded(candidate.code) ||
              (candidate.message !== undefined && typeof candidate.message !== "string"))) ||
          (candidate.ok === true &&
            (!candidate.evaluation ||
              Object.getPrototypeOf(candidate.evaluation) !== Object.prototype ||
              !bounded(candidate.evaluation.evaluatorVersion) ||
              !Object.hasOwn(candidate.evaluation, "result")))
        )
          throw new Error("Acceptance evaluator must return a synchronous evaluation or rejection");
        // Canonicalize even mismatched evaluations so malformed/async data throws uncached.
        json(candidate);
        if (!candidate.ok) return persist(candidate);
        if (candidate.evaluation.evaluatorVersion !== command.body.evaluatorVersion)
          return persist({ ok: false, code: "stale_evaluator" });
        const receipt: AcceptanceReceipt = {
          ...command.body,
          schemaVersion: 1,
          projectId: command.projectId,
          previousMainRevisionId: main.revisionId,
          requestId: command.requestId,
          actor: { role: "owner", namespace: caller.namespace },
          scorecard: candidate.evaluation.result,
        };
        const receiptJson = json(receipt);
        if (Buffer.byteLength(receiptJson) > MAX_ACCEPTANCE_RECEIPT_BYTES)
          return persist({ ok: false, code: "score_too_large" });
        const revisionId = randomUUID();
        // Copy the persisted bytes, not the evaluator's (potentially mutated) state/model.
        db.prepare(
          "INSERT INTO revisions (id, project_id, parent_id, change_set, snapshot, created_at) SELECT ?, project_id, ?, ?, snapshot, ? FROM revisions WHERE project_id = ? AND id = ?",
        ).run(
          revisionId,
          main.revisionId,
          json({
            type: "accept_option",
            command: JSON.parse(commandJson),
            acceptance: JSON.parse(receiptJson),
          }),
          new Date().toISOString(),
          command.projectId,
          source.revisionId,
        );
        db.prepare(
          "UPDATE refs SET head_revision_id = ? WHERE project_id = ? AND name = 'main'",
        ).run(revisionId, command.projectId);
        return persist({
          ok: true,
          revisionId,
          briefVersion: main.brief.version,
          effects: [],
          acceptance: receipt,
        });
      }
      if (!state) return persist({ ok: false, code: "ref_not_found" });
      if (command.baseRevision !== state.revisionId)
        return persist({ ok: false, code: "stale_base" });
      if (run) {
        if (run.status !== "running") return persist({ ok: false, code: "run_not_running" });
        if (!runCurrent(run)) return persist({ ok: false, code: "stale_run" });
      }
      if (command.type === "fork_ref") {
        if (readState(command.projectId, command.ref))
          return persist({ ok: false, code: "ref_exists" });
        const rejection = validate(state);
        if (rejection) return persist(rejection);
        db.prepare(
          "INSERT INTO refs (project_id, name, head_revision_id, fork_base_revision_id) VALUES (?, ?, ?, ?)",
        ).run(command.projectId, command.ref, state.revisionId, state.revisionId);
        return persist({
          ok: true,
          revisionId: state.revisionId,
          briefVersion: state.brief.version,
          effects: [],
        });
      }
      if (command.type === "set_brief") {
        if (command.body.baseBriefVersion !== state.brief.version)
          return persist({ ok: false, code: "stale_brief" });
        const rejection = validate(state);
        if (rejection) return persist(rejection);
        const version = state.brief.version + 1;
        db.prepare("INSERT INTO briefs (project_id, version, body) VALUES (?, ?, ?)").run(
          command.projectId,
          version,
          json(command.body.brief),
        );
        return persist({
          ok: true,
          revisionId: state.revisionId,
          briefVersion: version,
          effects: [],
        });
      }
      if (!evaluate) throw new Error("apply_changes requires a synchronous evaluator");
      const candidate = (evaluate as Evaluator)(state);
      if (!candidate || typeof candidate.ok !== "boolean")
        throw new Error("Evaluator must return a synchronous evaluation");
      if (!candidate.ok) return persist(candidate);
      const snapshot = json(candidate.model);
      const effects = JSON.parse(json(candidate.effects)) as unknown;
      const revisionId = randomUUID();
      db.prepare(
        "INSERT INTO revisions (id, project_id, parent_id, change_set, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        revisionId,
        command.projectId,
        state.revisionId,
        json({ body: command.body, effects }),
        snapshot,
        new Date().toISOString(),
      );
      db.prepare("UPDATE refs SET head_revision_id = ? WHERE project_id = ? AND name = ?").run(
        revisionId,
        command.projectId,
        command.ref,
      );
      if (run) {
        const updated = db
          .prepare(
            "UPDATE runs SET revision_id = ? WHERE id = ? AND status = 'running' AND revision_id = ?",
          )
          .run(revisionId, run.id, state.revisionId);
        if (updated.changes !== 1) throw new Error("Run cursor advancement failed");
      }
      return persist({ ok: true, revisionId, briefVersion: state.brief.version, effects });
    });
  }

  function readRun(id: string): RunRecord | null {
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      ref: String(row.ref),
      status: row.status as RunRecord["status"],
      outcome: row.outcome as RunRecord["outcome"],
      instruction: String(row.instruction),
      revisionId: row.revision_id === null ? null : String(row.revision_id),
      initialRevisionId: row.initial_revision_id === null ? null : String(row.initial_revision_id),
      baselineRevisionId:
        row.baseline_revision_id === null ? null : String(row.baseline_revision_id),
      briefVersion: Number(row.brief_version),
      strategySeed: row.strategy_seed === null ? null : JSON.parse(String(row.strategy_seed)),
      budget: JSON.parse(String(row.budget)),
      retryCount: Number(row.retry_count),
      evaluation: row.evaluation === null ? null : JSON.parse(String(row.evaluation)),
    };
  }

  function runCurrent(
    run: Pick<
      RunRecord,
      "projectId" | "ref" | "revisionId" | "briefVersion" | "baselineRevisionId"
    >,
  ): boolean {
    const state = readState(run.projectId, run.ref);
    return Boolean(
      state &&
        run.revisionId !== null &&
        state.revisionId === run.revisionId &&
        state.brief.version === run.briefVersion &&
        (state.forkBase?.revisionId ?? null) === run.baselineRevisionId &&
        (run.baselineRevisionId === null ||
          readState(run.projectId, "main")?.revisionId === run.baselineRevisionId),
    );
  }

  return {
    execute,
    readReview: (projectId, sourceRef) => {
      if (!bounded(projectId) || !bounded(sourceRef)) return { ok: false, code: "invalid_command" };
      return transaction(
        db,
        () => {
          if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId))
            return { ok: false, code: "project_not_found" };
          return reviewStates(projectId, sourceRef);
        },
        "read",
      );
    },
    readState,
    readSnapshot,
    readRun,
    readBriefs: (projectId) =>
      db
        .prepare("SELECT version, body FROM briefs WHERE project_id = ? ORDER BY version")
        .all(projectId)
        .map((row) => ({ version: Number(row.version), body: JSON.parse(String(row.body)) })),
    createRun: (run) =>
      transaction(db, () => {
        if (!readState(run.projectId, run.ref)) throw new Error("Run ref not found in project");
        if (
          !db
            .prepare("SELECT 1 FROM briefs WHERE project_id = ? AND version = ?")
            .get(run.projectId, run.briefVersion)
        )
          throw new Error("Run brief version not found in project");
        if (
          !bounded(run.id) ||
          run.status !== "queued" ||
          run.outcome !== null ||
          !Number.isSafeInteger(run.retryCount) ||
          run.retryCount < 0
        )
          throw new Error("Invalid initial run");
        if (!runCurrent(run)) throw new Error("Run pins are stale");
        db.prepare(
          "INSERT INTO runs (id, project_id, ref, status, outcome, instruction, brief_version, strategy_seed, budget, retry_count, revision_id, baseline_revision_id, initial_revision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          run.id,
          run.projectId,
          run.ref,
          run.status,
          run.outcome,
          run.instruction,
          run.briefVersion,
          json(run.strategySeed),
          json(run.budget),
          run.retryCount,
          run.revisionId,
          run.baselineRevisionId,
          run.revisionId,
        );
      }),
    updateRun: (id, patch) =>
      transaction(db, () => {
        const run = readRun(id);
        if (!run) throw new Error("Run not found");
        if (run.status !== "queued" && run.status !== "running")
          throw new Error("Run already finished");
        if ((patch.status as string) === "done") throw new Error("Use finalizeRun for outcomes");
        if (
          patch.retryCount !== undefined &&
          (!Number.isSafeInteger(patch.retryCount) || patch.retryCount < 0)
        )
          throw new Error("Invalid retry count");
        db.prepare("UPDATE runs SET status = ?, retry_count = ? WHERE id = ?").run(
          patch.status ?? run.status,
          patch.retryCount ?? run.retryCount,
          id,
        );
      }),
    finalizeRun: (id, outcome, evaluation) =>
      transaction(db, () => {
        const run = readRun(id);
        if (!run) return { ok: false, code: "run_not_found" };
        if (!runCurrent(run)) return { ok: false, code: "stale_run" };
        const score = evaluation === undefined ? null : json(evaluation);
        if (score !== null && Buffer.byteLength(score) > MAX_RUN_EVALUATION_BYTES)
          return { ok: false, code: "score_too_large" };
        if (
          run.status === "done" &&
          run.outcome === outcome &&
          (evaluation !== undefined || outcome === "not_found_within_budget") &&
          json(run.evaluation) === (score ?? "null")
        )
          return {
            ok: true,
            revisionId: run.revisionId as string,
            briefVersion: run.briefVersion,
            effects: [],
          };
        if (run.status !== "queued" && run.status !== "running")
          return { ok: false, code: "run_finished" };
        if (evaluation === undefined) {
          if (outcome !== "not_found_within_budget") return { ok: false, code: "score_required" };
        } else {
          if (
            !bounded(evaluation.evaluatorVersion) ||
            !bounded(evaluation.revisionId) ||
            !Number.isSafeInteger(evaluation.briefVersion) ||
            evaluation.briefVersion < 0 ||
            (evaluation.baselineRevisionId !== null && !bounded(evaluation.baselineRevisionId))
          )
            return { ok: false, code: "invalid_score" };
          if (
            evaluation.revisionId !== run.revisionId ||
            evaluation.briefVersion !== run.briefVersion ||
            evaluation.baselineRevisionId !== run.baselineRevisionId
          )
            return { ok: false, code: "stale_score" };
        }
        db.prepare("UPDATE runs SET status = 'done', outcome = ?, evaluation = ? WHERE id = ?").run(
          outcome,
          score,
          id,
        );
        return {
          ok: true,
          revisionId: run.revisionId as string,
          briefVersion: run.briefVersion,
          effects: [],
        };
      }),
    interruptRunningRuns: () =>
      transaction(db, () =>
        Number(
          db
            .prepare(
              "UPDATE runs SET status = 'interrupted' WHERE status = 'running' AND outcome IS NULL",
            )
            .run().changes,
        ),
      ),
    saveRunTurn: (turn) =>
      transaction(db, () => {
        if (!Number.isSafeInteger(turn.turn) || turn.turn < 0)
          throw new Error("Invalid turn number");
        const transcript = json(turn.transcript);
        const result = json(turn.result);
        const spend = json(turn.spend);
        if (
          Buffer.byteLength(transcript) + Buffer.byteLength(result) + Buffer.byteLength(spend) >
          MAX_RUN_TURN_BYTES
        )
          throw new Error("Run turn exceeds byte limit");
        db.prepare(
          "INSERT INTO run_turns (run_id, turn, transcript, result, spend) VALUES (?, ?, ?, ?, ?)",
        ).run(turn.runId, turn.turn, transcript, result, spend);
      }),
    readRunTurns: (runId) =>
      db.prepare("SELECT * FROM run_turns WHERE run_id = ? ORDER BY turn").all(runId).map(runTurn),
    readLastRunTurn: (runId) => {
      const row = db
        .prepare("SELECT * FROM run_turns WHERE run_id = ? ORDER BY turn DESC LIMIT 1")
        .get(runId);
      return row ? runTurn(row) : null;
    },
    listProjects: () =>
      db
        .prepare("SELECT id, created_at FROM projects ORDER BY created_at, id")
        .all()
        .map((row) => ({ projectId: String(row.id), createdAt: String(row.created_at) })),
    listRefs: (projectId) =>
      db
        .prepare(
          "SELECT name, head_revision_id, fork_base_revision_id FROM refs WHERE project_id = ? ORDER BY name",
        )
        .all(projectId)
        .map((row) => ({
          ref: String(row.name),
          revisionId: String(row.head_revision_id),
          forkBaseRevisionId:
            row.fork_base_revision_id === null ? null : String(row.fork_base_revision_id),
        })),
    listRuns: (projectId) =>
      db
        .prepare("SELECT id FROM runs WHERE project_id = ? ORDER BY rowid")
        .all(projectId)
        .map((row) => readRun(String(row.id)) as RunRecord),
    close: () => db.close(),
  };
}
