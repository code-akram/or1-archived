import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Op, scorecard } from "@or1/core";
import { dataDir, openStore } from "@or1/store";
import { acceptOption } from "@or1/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateFixture, loadFixture, readFixtureJson, replayWitness } from "../src/evaluation.ts";

const fixtures = fileURLToPath(new URL("../../../evals/fixtures/", import.meta.url));
const ids = ["synthetic-hall-living-study", "synthetic-asymmetric-bedrooms"];
let directory: string;
beforeEach(() => {
  mkdirSync(dataDir(), { recursive: true });
  directory = mkdtempSync(join(dataDir(), "evaluation-test-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("private disk-backed test-fit evaluations", () => {
  it.each(ids)(
    "replays %s through the real runner, reloads exact scores, and accepts only through owner approval",
    async (id) => {
      const fixture = loadFixture(join(fixtures, id));
      const ops = readFixtureJson(join(fixtures, id, "witness-ops.json")) as Op[];
      const result = await evaluateFixture({
        fixture,
        mode: "witness-replay",
        ...replayWitness(ops),
        outputRoot: directory,
      });
      expect(result.summary.run).toMatchObject({ status: "done", outcome: "options" });
      expect(result.summary).toMatchObject({
        mode: "witness-replay",
        mainUnchanged: true,
        acceptancePerformed: false,
        witnessAvailableToModel: true,
        withinShellBounds: true,
        passed: true,
      });
      expect(result.review.option.model).toEqual(
        readFixtureJson(join(fixtures, id, "witness.json")),
      );
      expect(result.review.option.scorecard.valid).toBe(true);
      expect(result.review.option.scorecard.requirements).toHaveLength(id === ids[0] ? 3 : 4);
      expect(
        result.review.option.scorecard.requirements.every((row) => row.present === row.quantity),
      ).toBe(true);
      expect(JSON.parse(readFileSync(join(result.directory, "summary.json"), "utf8"))).toEqual(
        result.summary,
      );
      expect(JSON.parse(readFileSync(join(result.directory, "review.json"), "utf8"))).toEqual(
        result.review,
      );
      expect(statSync(result.directory).mode & 0o777).toBe(0o700);
      expect(statSync(result.summary.database).mode & 0o777).toBe(0o600);
      expect(statSync(join(result.directory, "turns.json")).mode & 0o777).toBe(0o600);
      const reloaded = openStore(result.summary.database);
      try {
        const { projectId, run } = result.summary;
        const option = reloaded.readState(projectId, "option");
        const initialMain = reloaded.readState(projectId, "main");
        expect(option?.revisionId).toBe(run.revisionId);
        expect(initialMain?.model).toEqual(fixture.shell);
        expect(reloaded.readRun(run.id)).toEqual(run);
        expect(run.evaluation?.result).toEqual(
          scorecard(result.review.option.model, fixture.brief, fixture.shell),
        );
        const turns = reloaded.readRunTurns(run.id);
        const command = {
          projectId,
          ref: "main" as const,
          baseRevision: result.review.main.revisionId,
          requestId: "explicit-owner-approval",
          body: {
            sourceRef: "option",
            sourceRevisionId: result.review.option.revisionId,
            briefVersion: result.review.briefVersion,
            baselineRevisionId: result.review.baselineRevisionId,
            evaluatorVersion: result.review.option.scorecard.evaluatorVersion,
          },
        };
        const context = {
          store: reloaded,
          role: "owner" as const,
          namespace: `local-eval-owner:${run.id}`,
        };
        const acceptance = await acceptOption.execute(command, context);
        expect(acceptance.data).toMatchObject({
          ok: true,
          acceptance: { sourceRevisionId: run.revisionId },
        });
        expect(reloaded.readState(projectId, "main")?.model).toEqual(result.review.option.model);
        expect((await acceptOption.execute(command, context)).data).toEqual(acceptance.data);
        expect(reloaded.readRun(run.id)).toEqual(run);
        expect(reloaded.readRunTurns(run.id)).toEqual(turns);
      } finally {
        reloaded.close();
      }
    },
  );

  it("records an unsuccessful replay honestly rather than promoting an unchanged shell or a done assertion", async () => {
    const fixture = loadFixture(join(fixtures, ids[0] as string));
    const result = await evaluateFixture({
      fixture,
      mode: "witness-replay",
      ...replayWitness([]),
      outputRoot: directory,
    });
    expect(result.summary.run).toMatchObject({
      status: "done",
      outcome: "not_found_within_budget",
    });
    expect(result.review.option.scorecard.valid).toBe(false);
    expect(result.review.eligibility).toEqual({ allowed: false, code: "invalid_option" });
    expect(result.review.main.model).toEqual(fixture.shell);
    expect(result.summary.mainUnchanged).toBe(true);
    expect(result.summary.passed).toBe(false);
  });

  it("does not call a gate-valid candidate a successful test-fit when a stray wall lies outside the original shell", async () => {
    const fixture = loadFixture(join(fixtures, ids[0] as string));
    const ops = readFixtureJson(join(fixtures, ids[0] as string, "witness-ops.json")) as Op[];
    const result = await evaluateFixture({
      fixture,
      mode: "witness-replay",
      ...replayWitness([
        ...ops,
        { op: "add_wall", start: { x: 12000, y: 0 }, end: { x: 13000, y: 0 }, thickness: 100 },
      ]),
      outputRoot: directory,
    });
    expect(result.summary.run.outcome).toBe("options");
    expect(result.review.option.scorecard.valid).toBe(true);
    expect(result.summary.withinShellBounds).toBe(false);
    expect(result.summary.passed).toBe(false);
    expect(result.summary.mainUnchanged).toBe(true);
  });

  it("creates independent run directories and identities, never resetting a prior evaluation", async () => {
    const fixture = loadFixture(join(fixtures, ids[0] as string));
    const options = { fixture, mode: "witness-replay" as const, outputRoot: directory };
    const first = await evaluateFixture({ ...options, ...replayWitness([]) });
    const firstBytes = readFileSync(join(first.directory, "summary.json"));
    const second = await evaluateFixture({ ...options, ...replayWitness([]) });
    expect(first.directory).not.toBe(second.directory);
    expect(first.summary.run.id).not.toBe(second.summary.run.id);
    expect(first.summary.projectId).not.toBe(second.summary.projectId);
    expect(readFileSync(join(first.directory, "summary.json"))).toEqual(firstBytes);
  });

  it("loads shell and brief only, even with malformed witness files present", () => {
    const original = loadFixture(join(fixtures, ids[0] as string));
    writeFileSync(join(directory, "shell.json"), JSON.stringify(original.shell));
    writeFileSync(join(directory, "brief.json"), JSON.stringify(original.brief));
    writeFileSync(join(directory, "witness.json"), "NEVER READ THIS");
    writeFileSync(join(directory, "witness-ops.json"), "NEVER READ THIS");
    expect(loadFixture(directory)).toEqual(original);
  });

  it("rejects malformed UTF-8 and an oversized fixture before decoding JSON", () => {
    const path = join(directory, "input.json");
    writeFileSync(
      path,
      Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    );
    expect(() => readFixtureJson(path)).toThrow();
    writeFileSync(path, Buffer.alloc(262_145, 32));
    expect(() => readFixtureJson(path)).toThrow("Fixture file exceeds");
  });

  it("rejects repository output paths and an outside symlink resolving into the repository", async () => {
    const fixture = loadFixture(join(fixtures, ids[0] as string));
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const symlink = join(directory, "repo-link");
    symlinkSync(repository, symlink, "dir");
    for (const outputRoot of [repository, join(repository, ".amp/in/private-eval"), symlink])
      await expect(
        evaluateFixture({ fixture, mode: "witness-replay", ...replayWitness([]), outputRoot }),
      ).rejects.toThrow("outside the repository");
  });
});
