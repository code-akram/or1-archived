import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Project data lives outside the repo: $OR1_DATA_DIR, else $XDG_DATA_HOME/or1, else ~/.local/share/or1. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OR1_DATA_DIR) return env.OR1_DATA_DIR;
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "or1");
}

/** Schema stub. Revisions form a tree; refs (main, option-*) point at heads. */
const SCHEMA = `
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

export type Store = {
  readonly db: DatabaseSync;
  close(): void;
};

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return { db, close: () => db.close() };
}
