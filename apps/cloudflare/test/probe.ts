import { DurableObject } from "cloudflare:workers";
import { createStore } from "@or1/store/portable";
import { applyChangesTool, createProject } from "@or1/tools";
import { seedDemoV1, syntheticBrief, syntheticModel } from "../src/demo.ts";
import { sqlDriver } from "../src/sql.ts";

export { default, Project, Provisioner } from "../src/index.ts";

const realNow = Date.now;

/** Test-only RPC. Not exported or bundled by the production entrypoint. */
export class Probe extends DurableObject {
  setClockOffset(milliseconds: number) {
    // Advance the key-cache clock without sleeping; JWT cryptographic verification still runs
    // natively. This lives only in the test bundle, never the deployed entrypoint.
    Date.now = () => realNow() + milliseconds;
  }

  async check() {
    const driver = sqlDriver(this.ctx.storage);
    const store = createStore(driver);
    const version = driver.getSchemaVersion();
    const missing =
      driver.prepare("SELECT id FROM projects WHERE id = 'missing'").get() === undefined;
    driver.exec(
      "CREATE TABLE counter (id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX counter_value ON counter(value)",
    );
    const insertChanges = driver.prepare("INSERT INTO counter VALUES (1, 'a')").run().changes;
    const updateChanges = driver
      .prepare("UPDATE counter SET value = 'b' WHERE id = 1")
      .run().changes;
    let transactionRolledBack = false;
    try {
      driver.transaction(() => {
        driver.prepare("INSERT INTO counter VALUES (2, 'rollback')").run();
        driver.setSchemaVersion(999);
        throw new Error("Expected rollback");
      }, "write");
    } catch {
      transactionRolledBack =
        driver.getSchemaVersion() === version &&
        driver.prepare("SELECT id FROM counter WHERE id = 2").get() === undefined;
    }
    let foreignKey = false;
    try {
      driver
        .prepare("INSERT INTO briefs(project_id, version, body) VALUES ('missing', 1, '{}')")
        .run();
    } catch {
      foreignKey = true;
    }
    await seedDemoV1(store);
    const ctx = { store, role: "owner" as const, namespace: "test-native" };
    const main = store.readState("demo-workspace", "main");
    const source = store.readState("demo-workspace", "option-a");
    if (!main || !source) throw new Error("Missing demo");
    let immutable = false;
    try {
      driver.prepare("UPDATE revisions SET snapshot = '{}' WHERE id = ?").run(main.revisionId);
    } catch {
      immutable = true;
    }
    const command = {
      type: "apply_changes" as const,
      projectId: "demo-workspace",
      ref: "option-a",
      baseRevision: source.revisionId,
      requestId: "rollback-evaluator",
      body: {},
    };
    let evaluatorRollback = false;
    const before = driver.prepare("SELECT COUNT(*) AS count FROM request_outcomes").get()?.count;
    try {
      store.execute(command, ctx, () => {
        throw new Error("Expected evaluator throw");
      });
    } catch {
      evaluatorRollback =
        store.readState("demo-workspace", "option-a")?.revisionId === source.revisionId &&
        driver.prepare("SELECT COUNT(*) AS count FROM request_outcomes").get()?.count === before;
    }
    const changed = await applyChangesTool.execute(
      {
        projectId: "demo-workspace",
        ref: "option-a",
        baseRevision: source.revisionId,
        requestId: "advance-after-provisioning",
        body: {
          ops: [{ op: "update_opening", id: "O1", offset: 1000 }],
          briefVersion: 1,
          baselineRevisionId: main.revisionId,
        },
      },
      ctx,
    );
    if (!(changed.data as { ok: boolean }).ok) throw new Error("Advance rejected");
    const head = store.readState("demo-workspace", "option-a")?.revisionId;
    const count = driver.prepare("SELECT COUNT(*) AS count FROM request_outcomes").get()?.count;
    await seedDemoV1(store);
    const retryPreservedHead =
      store.readState("demo-workspace", "option-a")?.revisionId === head &&
      head !== source.revisionId &&
      driver.prepare("SELECT COUNT(*) AS count FROM request_outcomes").get()?.count === count;
    store.close();
    const reopened = createStore(driver);
    const reopenedHead = reopened.readState("demo-workspace", "option-a")?.revisionId === head;
    return {
      version,
      missing,
      insertChanges,
      updateChanges,
      transactionRolledBack,
      foreignKey,
      immutable,
      evaluatorRollback,
      retryPreservedHead,
      reopenedHead,
    };
  }

  async unexpected() {
    const store = createStore(sqlDriver(this.ctx.storage));
    await createProject.execute(
      {
        projectId: "demo-workspace",
        ref: "main",
        baseRevision: null,
        requestId: "foreign-create",
        body: { model: syntheticModel(), brief: syntheticBrief },
      },
      { store, role: "owner", namespace: "different-admin" },
    );
    const before = store.readState("demo-workspace", "main")?.revisionId;
    try {
      await seedDemoV1(store);
    } catch {
      return {
        rejected: true,
        unchanged: store.readState("demo-workspace", "main")?.revisionId === before,
      };
    }
    return { rejected: false, unchanged: false };
  }
}
