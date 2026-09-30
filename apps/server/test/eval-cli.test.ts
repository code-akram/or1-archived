import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dataDir } from "@or1/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "../src/eval-cli.ts";
import * as subscription from "../src/subscription.ts";

vi.mock("node:readline/promises", { spy: true });
vi.mock("../src/subscription.ts", { spy: true });

const main = fileURLToPath(new URL("../src/eval-main.ts", import.meta.url));
let directory: string;
beforeEach(() => {
  mkdirSync(dataDir(), { recursive: true });
  directory = mkdtempSync(join(dataDir(), "eval-cli-test-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function command(args: string[]) {
  return spawnSync(process.execPath, [main, ...args], {
    cwd: "/",
    encoding: "utf8",
    env: { ...process.env, OR1_DATA_DIR: directory, OPENAI_API_KEY: "synthetic-unused-key" },
    timeout: 10_000,
  });
}

describe("explicit private evaluation command", () => {
  it("shows help without opening a store or attempting authentication", () => {
    const result = command([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("NOT agent design-quality evidence");
    expect(result.stdout).toContain("NOT a hard provider usage or billing limit");
    expect(readdirSync(directory)).toEqual([]);
  });

  it.each(["synthetic-hall-living-study", "synthetic-asymmetric-bedrooms"])(
    "runs %s by fixture ID independently of the working directory, even with an ambient API key",
    (fixture) => {
      const result = command(["--fixture", fixture, "--mode", "replay"]);
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        mode: "witness-replay",
        outcome: "options",
        valid: true,
        withinShellBounds: true,
        passed: true,
        mainUnchanged: true,
        acceptancePerformed: false,
      });
      const report = JSON.parse(readFileSync(join(output.directory, "summary.json"), "utf8"));
      expect(report.witnessAvailableToModel).toBe(true);
      expect(report.model).toEqual({ provider: "synthetic", id: "witness-replay" });
      expect(result.stdout + result.stderr).not.toContain("synthetic-unused-key");
    },
  );

  it.each([
    { args: ["--mode", "subscription", "--list-models"] },
    { args: ["--mode", "subscription", "--fixture", "synthetic-hall-living-study"] },
  ])(
    "fails closed without a TTY rather than logging in or falling back to the API key: %j",
    ({ args }) => {
      const result = command(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("interactive OAuth login");
      expect(result.stdout).toBe("");
      expect(readdirSync(directory)).toEqual([]);
    },
  );

  it("requires explicit mode and prevents fixture traversal, ignored model flags, and raw error disclosures", () => {
    for (const args of [
      ["--fixture", "synthetic-hall-living-study"],
      ["--fixture", "../../private", "--mode", "replay"],
      [
        "--fixture",
        "synthetic-hall-living-study",
        "--mode",
        "replay",
        "--model",
        "synthetic-unused-key",
      ],
      ["--unsafe-synthetic-auth-detail"],
    ]) {
      const result = command(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No provider error details are logged");
      expect(result.stdout + result.stderr).not.toContain("synthetic-unused-key");
      expect(result.stdout + result.stderr).not.toContain("unsafe-synthetic-auth-detail");
    }
    expect(readdirSync(directory)).toEqual([]);
  });

  it.each(["overall", "per-prompt"])(
    "cancels the terminal prompt on %s abort and closes it without listing or starting a run",
    async (source) => {
      const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      const perPrompt = new AbortController();
      const terminal = {
        question: vi.fn(async (_query: string, options?: { signal?: AbortSignal }) => {
          if (source === "overall") process.emit("SIGINT");
          else perPrompt.abort();
          expect(options?.signal?.aborted).toBe(true);
          options?.signal?.throwIfAborted();
          return "unexpected";
        }),
        close: vi.fn(),
      };
      const session: ReturnType<typeof subscription.createSubscription> = {
        login: vi.fn(async (interaction) => {
          await interaction.prompt({
            type: "text",
            message: "Synthetic manual callback",
            signal: perPrompt.signal,
          });
        }),
        list: vi.fn(),
        select: vi.fn(),
      };
      try {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.mocked(readline.createInterface).mockReturnValue(
          terminal as unknown as readline.Interface,
        );
        vi.mocked(subscription.createSubscription).mockReturnValue(session);
        await expect(runEvalCli(["--mode", "subscription", "--list-models"])).rejects.toThrow();
        expect(terminal.question).toHaveBeenCalledOnce();
        expect(terminal.close).toHaveBeenCalledOnce();
        expect(session.list).not.toHaveBeenCalled();
        expect(session.select).not.toHaveBeenCalled();
        expect(readdirSync(directory)).toEqual([]);
      } finally {
        if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
        else Reflect.deleteProperty(process.stdin, "isTTY");
        if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
        else Reflect.deleteProperty(process.stdout, "isTTY");
        vi.restoreAllMocks();
      }
    },
  );
});
