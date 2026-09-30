import type { SqlBinding, SqlDriver, SqlRow } from "@or1/store/portable";

/** DO SQLite owns transactions and enforces FKs; never issue BEGIN or user_version PRAGMAs. */
export function sqlDriver(storage: DurableObjectStorage): SqlDriver {
  const sql = storage.sql;
  return {
    prepare(query: string) {
      return {
        get(...bindings: SqlBinding[]): SqlRow | undefined {
          return sql.exec<SqlRow>(query, ...bindings).toArray()[0];
        },
        all(...bindings: SqlBinding[]): SqlRow[] {
          return sql.exec<SqlRow>(query, ...bindings).toArray();
        },
        run(...bindings: SqlBinding[]): { changes: number } {
          // Consume the cursor. rowsWritten counts index updates too, unlike SQLite changes().
          sql.exec(query, ...bindings).toArray();
          return { changes: Number(sql.exec("SELECT changes() AS changes").toArray()[0]?.changes) };
        },
      };
    },
    exec(query: string) {
      sql.exec(query).toArray();
    },
    transaction<T>(callback: () => T, _mode: "read" | "write"): T {
      return storage.transactionSync(callback);
    },
    getSchemaVersion() {
      // Called by createStore inside its migration transaction, never from a constructor/session.
      sql
        .exec(
          "CREATE TABLE IF NOT EXISTS or1_cloud_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)",
        )
        .toArray();
      return Number(
        sql.exec("SELECT version FROM or1_cloud_schema WHERE singleton = 1").toArray()[0]
          ?.version ?? 0,
      );
    },
    setSchemaVersion(version: number) {
      sql
        .exec(
          "INSERT INTO or1_cloud_schema(singleton, version) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version",
          version,
        )
        .toArray();
    },
    close() {},
  };
}
