import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, type PortableStore, type SqlDriver, type SqlRow } from "./portable.ts";

export * from "./portable.ts";

export type Store = PortableStore & {
  /** For inspection and legacy compatibility only. Application writes use execute/run helpers. */
  readonly db: DatabaseSync;
};

/** Project data lives outside the repo: $OR1_DATA_DIR, else $XDG_DATA_HOME/or1, else ~/.local/share/or1. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OR1_DATA_DIR) return env.OR1_DATA_DIR;
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "or1");
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  } catch (error) {
    db.close();
    throw error;
  }
  const driver: SqlDriver = {
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        get: (...bindings) => statement.get(...bindings) as SqlRow | undefined,
        all: (...bindings) => statement.all(...bindings) as SqlRow[],
        run: (...bindings) => ({ changes: Number(statement.run(...bindings).changes) }),
      };
    },
    exec: (sql) => db.exec(sql),
    transaction: (callback, mode) => {
      db.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        const result = callback();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getSchemaVersion: () => Number(db.prepare("PRAGMA user_version").get()?.user_version),
    setSchemaVersion: (version) => db.exec(`PRAGMA user_version = ${version}`),
    close: () => db.close(),
  };
  return { ...createStore(driver), db };
}
