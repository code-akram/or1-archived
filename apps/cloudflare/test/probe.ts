import { DurableObject } from "cloudflare:workers";
import { createStore } from "@or1/store/portable";
import { applyChangesTool, createProject, reviewOption, type ToolContext } from "@or1/tools";
import type { Env } from "../src/config.ts";
import { seedDemoV1, syntheticBrief, syntheticModel } from "../src/demo.ts";
import worker from "../src/index.ts";
import { sqlDriver } from "../src/sql.ts";

export { default, Project, Provisioner } from "../src/index.ts";

const realNow = Date.now;
const executeReview = reviewOption.execute;
let reviewContext:
  | {
      namespace: string | undefined;
      role: ToolContext["role"];
      reviewProjectId: string | undefined;
    }
  | undefined;
let reviewExpiry: number | undefined;
// Observe the real registry call and optionally cross the deadline after its successful await.
// Neither instrumentation nor clock controls are included in the production bundle.
reviewOption.execute = async (params, ctx) => {
  reviewContext = {
    namespace: ctx.namespace,
    role: ctx.role,
    reviewProjectId: ctx.reviewProjectId,
  };
  const result = await executeReview(params, ctx);
  if (reviewExpiry !== undefined) {
    const expiredAt = reviewExpiry;
    Date.now = () => expiredAt;
  }
  return result;
};

/** Test-only RPC. Not exported or bundled by the production entrypoint. */
export class Probe extends DurableObject<Env> {
  setClockOffset(milliseconds: number) {
    // Advance the key-cache clock without sleeping; JWT cryptographic verification still runs
    // natively. This lives only in the test bundle, never the deployed entrypoint.
    Date.now = () => realNow() + milliseconds;
  }

  setClock(milliseconds: number, expireOnRead = Infinity, expiredAt = milliseconds) {
    let reads = 0;
    Date.now = () => (++reads >= expireOnRead ? expiredAt : milliseconds);
  }

  expireAfterReview(expiresAt: number) {
    reviewExpiry = expiresAt;
  }

  lastReviewContext() {
    return reviewContext;
  }

  async request(
    target: string,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ) {
    // Construct inside workerd: the Node proxy transport strips empty Origin headers and
    // cannot faithfully represent direct DO POST origins. Exercise the native request instead.
    const request = new Request(url, init);
    const response =
      target === "worker"
        ? await worker.fetch(request, this.env)
        : await this.env.PROJECTS.get(this.env.PROJECTS.idFromName(target)).fetch(request);
    return { status: response.status, body: await response.text() };
  }

  async delayedReview(before: number, expiresAt: number) {
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Let the DO pass its entry deadline before releasing the body at exact expiry.
    Date.now = () => {
      release?.();
      return before;
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await entered;
        Date.now = () => expiresAt;
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ projectId: "demo-workspace", ref: "option-a" }),
          ),
        );
        controller.close();
      },
    });
    const response = await this.env.PROJECTS.get(
      this.env.PROJECTS.idFromName("demo-workspace"),
    ).fetch(
      new Request(`${this.env.PUBLIC_ORIGIN}/api/tools/review_option`, {
        method: "POST",
        headers: {
          "X-Or1-Project-Id": "demo-workspace",
          Origin: this.env.PUBLIC_ORIGIN,
          "Content-Type": "application/json",
        },
        body,
      }),
    );
    return { status: response.status, body: await response.text() };
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
