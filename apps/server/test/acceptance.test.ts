import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { applyChanges, type Brief, emptyModel, type Op } from "@or1/core";
import { dataDir, openStore, type Store } from "@or1/store";
import type { AcceptOptionInput, AcceptOptionResult, ReviewOptionResult } from "@or1/tools";
import { tools } from "@or1/tools";
import { expect, it } from "vitest";
import { createHttpServer } from "../src/http.ts";

const token = "synthetic-test-credential-not-a-secret-123456";
const brief: Brief = {
  schemaVersion: 2,
  rooms: [{ id: "office", program: "office", quantity: 1, hard: true, targetAreaM2: 22.04 }],
  constraints: [],
};

async function execute(store: Store, name: string, params: unknown) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  const { data } = await tool.execute(params, { role: "owner", namespace: "local-owner", store });
  expect(data).toMatchObject({ ok: true });
  return data;
}

async function fixture(store: Store) {
  const corners = [
    { x: -2000, y: -1000 },
    { x: 4000, y: -1000 },
    { x: 4000, y: 3000 },
    { x: -2000, y: 3000 },
  ];
  const ops: Op[] = corners.map((start, index) => ({
    op: "add_wall",
    start,
    end: corners[(index + 1) % 4] as { x: number; y: number },
    thickness: 200,
    locked: true,
  }));
  ops.push({ op: "add_door", wall: "W1", offset: 1500, width: 1000, entrance: true });
  const shell = applyChanges(emptyModel(), ops, "owner");
  if (!shell.ok) throw new Error(shell.rejection.detail);
  await execute(store, "create_project", {
    projectId: "review-test",
    ref: "main",
    baseRevision: null,
    requestId: "create",
    body: { model: shell.model, brief },
  });
  const main = store.readState("review-test", "main");
  if (!main) throw new Error("Missing main");
  for (const ref of ["option-a", "option-b"]) {
    await execute(store, "fork_ref", {
      projectId: main.projectId,
      ref,
      baseRevision: main.revisionId,
      requestId: `fork-${ref}`,
      body: { sourceRef: "main" },
    });
    await execute(store, "apply_changes", {
      projectId: main.projectId,
      ref,
      baseRevision: main.revisionId,
      requestId: `tag-${ref}`,
      body: {
        ops: [{ op: "tag_space", space: "S1", program: "office", requirementId: "office" }],
        briefVersion: main.brief.version,
        baselineRevisionId: main.revisionId,
      },
    });
  }
  return main;
}

it("reviews and accepts over authenticated HTTP, then replays the exact receipt after restart and advancement", async () => {
  mkdirSync(dataDir(), { recursive: true });
  const directory = mkdtempSync(join(dataDir(), "acceptance-integration-"));
  const path = join(directory, "test.sqlite");
  let store = openStore(path);
  let server = createHttpServer({
    owner: { token, context: { role: "owner", namespace: "local-owner", store } },
  });
  const start = async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  try {
    const main = await fixture(store);
    let base = await start();
    const post = async (name: string, body: unknown, credential = token) => {
      const response = await fetch(`${base}/tools/${name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return response.json();
    };
    const review = (await post("review_option", {
      projectId: main.projectId,
      ref: "option-a",
    })) as ReviewOptionResult;
    if (!review.ok) throw new Error(review.code);
    expect(review.eligibility).toEqual({ allowed: true });
    expect(review.main.scorecard.valid).toBe(false);
    expect(review.option.scorecard).toMatchObject({
      valid: true,
      certification: "none",
      scores: [{ score: "area_fit", value: 1 }],
      requirements: [{ id: "office", present: 1, spaces: ["S1"] }],
    });
    expect(review.option.derived.spaces[0]?.netArea).toBe(22_040_000);
    const intent: AcceptOptionInput = {
      projectId: main.projectId,
      ref: "main",
      baseRevision: review.main.revisionId,
      requestId: "reviewed-intent",
      body: {
        sourceRef: review.ref,
        sourceRevisionId: review.option.revisionId,
        briefVersion: review.briefVersion,
        baselineRevisionId: review.baselineRevisionId,
        evaluatorVersion: review.option.scorecard.evaluatorVersion,
      },
    };
    store.createRun({
      id: "active-run",
      projectId: main.projectId,
      ref: review.ref,
      status: "queued",
      outcome: null,
      instruction: "Try another edit",
      revisionId: review.option.revisionId,
      baselineRevisionId: review.baselineRevisionId,
      briefVersion: review.briefVersion,
      strategySeed: null,
      budget: {},
      retryCount: 0,
    });
    store.updateRun("active-run", { status: "running" });
    const run = store.readRun("active-run");
    // Simulate a lost first response: a second identical request must replay, not promote twice.
    const accepted = (await post("accept_option", intent)) as AcceptOptionResult;
    if (!accepted.ok) throw new Error(accepted.code);
    expect(await post("accept_option", intent)).toEqual(accepted);
    expect(accepted.acceptance.scorecard).toEqual(review.option.scorecard);
    expect(accepted.acceptance.actor).toEqual({ role: "owner", namespace: "local-owner" });
    expect(store.readState(main.projectId, "main")?.model).toEqual(review.option.model);
    expect(store.readState(main.projectId, review.ref)?.revisionId).toBe(review.option.revisionId);
    expect(store.readSnapshot(main.projectId, main.revisionId)).toEqual(main.model);
    expect(store.readRun("active-run")).toEqual(run);
    const row = store.db
      .prepare("SELECT parent_id, change_set FROM revisions WHERE id = ?")
      .get(accepted.revisionId);
    expect(row?.parent_id).toBe(main.revisionId);
    expect(JSON.parse(String(row?.change_set))).toMatchObject({
      type: "accept_option",
      acceptance: accepted.acceptance,
    });
    const apply = tools.find((item) => item.name === "apply_changes");
    if (!apply) throw new Error("Missing apply");
    const late = await apply.execute(
      {
        projectId: main.projectId,
        ref: review.ref,
        baseRevision: review.option.revisionId,
        requestId: "late-run-edit",
        body: {
          ops: [],
          briefVersion: review.briefVersion,
          baselineRevisionId: review.baselineRevisionId,
        },
      },
      { role: "agent", namespace: "agent", runId: "active-run", store },
    );
    expect(late.data).toMatchObject({ ok: false, code: "stale_run" });
    const sibling = (await post("review_option", {
      projectId: main.projectId,
      ref: "option-b",
    })) as ReviewOptionResult;
    if (!sibling.ok) throw new Error(sibling.code);
    expect(sibling.option.scorecard.valid).toBe(true);
    expect(sibling.eligibility).toEqual({ allowed: false, code: "stale_baseline" });
    expect(
      await post("accept_option", {
        ...intent,
        requestId: "sibling",
        baseRevision: accepted.revisionId,
        body: {
          ...intent.body,
          sourceRef: sibling.ref,
          sourceRevisionId: sibling.option.revisionId,
        },
      }),
    ).toMatchObject({ ok: false, code: "stale_baseline" });
    await execute(store, "set_brief", {
      projectId: main.projectId,
      ref: "main",
      baseRevision: accepted.revisionId,
      baseBriefVersion: review.briefVersion,
      requestId: "advance-brief",
      body: { brief: { ...brief, name: "Reviewed brief update" } },
    });
    await stop();
    store.close();
    store = openStore(path);
    const rotatedToken = `${token}-rotated`;
    server = createHttpServer({
      owner: { token: rotatedToken, context: { role: "owner", namespace: "local-owner", store } },
    });
    base = await start();
    expect(await post("accept_option", intent, rotatedToken)).toEqual(accepted);
    expect(store.readState(main.projectId, "main")?.revisionId).toBe(accepted.revisionId);
    expect(store.readState(main.projectId, "main")?.brief.version).toBe(2);
    expect(store.readRun("active-run")).toEqual(run);
    expect(
      await post(
        "accept_option",
        { ...intent, body: { ...intent.body, evaluatorVersion: "changed" } },
        rotatedToken,
      ),
    ).toMatchObject({ ok: false, code: "request_conflict" });
  } finally {
    if (server.listening) await stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
