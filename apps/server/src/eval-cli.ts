import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { type Op, OpsSchema } from "@or1/core";
import { Value } from "typebox/value";
import { evaluateFixture, loadFixture, readFixtureJson, replayWitness } from "./evaluation.ts";
import { createSubscription } from "./subscription.ts";

const HELP = `usage: pnpm eval --fixture <fixture-id> --mode <replay|subscription> [--model <id>]
       pnpm eval --mode subscription --list-models

Replay is a disclosed deterministic witness check, NOT agent design-quality evidence.
Subscription mode requires interactive human ChatGPT OAuth login and uses no witness or API key.
Credentials stay in process memory; no paid API fallback or public run-start route exists.
Live runs use the bounded runner defaults. ChatGPT subscription shaping omits the provider output
token cap: accounting/cancellation are NOT a hard provider usage or billing limit.
Each run writes a new private database, review and ledger under OR1_DATA_DIR/eval-runs.
Main is not automatically accepted or modified. Cloudflare's public demo remains read-only.`;

/** Nonsecret stable installation identity. OAuth access/refresh tokens are never written here. */
function deviceId(): string {
  const directory = join(homedir(), ".config", "or1");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "device-id");
  try {
    writeFileSync(path, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const value = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw new Error("Invalid installation device ID");
  return value;
}

export async function runEvalCli(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      fixture: { type: "string" },
      mode: { type: "string" },
      model: { type: "string" },
      "list-models": { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!args.length || values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.mode !== "replay" && values.mode !== "subscription")
    throw new Error("Explicit replay or subscription mode required");
  if (values.mode === "replay" && (values.model || values["list-models"]))
    throw new Error("Model options are subscription-only");
  if (!values["list-models"] && (!values.fixture || !/^synthetic-[a-z0-9-]+$/.test(values.fixture)))
    throw new Error("A public synthetic fixture ID is required");
  if (values["list-models"] && (values.fixture || values.model))
    throw new Error("Model listing does not run a fixture");
  const directory = values.fixture
    ? fileURLToPath(new URL(`../../../evals/fixtures/${values.fixture}/`, import.meta.url))
    : undefined;
  const fixture = directory ? loadFixture(directory) : undefined;
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    let selected: ReturnType<typeof replayWitness>;
    if (values.mode === "replay") {
      const ops = readFixtureJson(join(directory as string, "witness-ops.json"));
      if (!Value.Check(OpsSchema, ops)) throw new Error("Invalid witness operations");
      selected = replayWitness(ops as Op[]);
    } else {
      // Never initiate unattended login, use cached third-party secrets or run a paid-key fallback.
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error("Subscription login requires an interactive terminal");
      console.log(
        "Personal ChatGPT subscription evaluation: this consumes your subscription allowance.",
      );
      console.log(
        "The provider output-token cap is omitted; the runner budget is not a hard usage cap.",
      );
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const loginSignal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(10 * 60_000)]);
      const interaction: AuthInteraction = {
        signal: loginSignal,
        async prompt(prompt) {
          if (prompt.type === "secret") throw new Error("Password/token input is not supported");
          if (prompt.type === "select")
            console.log(
              prompt.options
                .map((option, index) => `${index + 1}. ${option.label} (${option.id})`)
                .join("\n"),
            );
          const answer = await terminal.question(`${prompt.message}\n> `, {
            signal: AbortSignal.any([loginSignal, ...(prompt.signal ? [prompt.signal] : [])]),
          });
          if (prompt.type !== "select") return answer;
          const choice =
            prompt.options.find((option) => option.id === answer) ??
            prompt.options[Number(answer) - 1];
          if (!choice) throw new Error("Invalid selection");
          return choice.id;
        },
        notify(event) {
          if (event.type === "auth_url") {
            console.log(`Authorize in your own browser: ${event.url}`);
            console.log(
              "If the loopback callback cannot reach Arch, paste its full redirect URL in this terminal—not chat.",
            );
          } else if (event.type === "device_code") {
            console.log(`Authorize at ${event.verificationUri}; code ${event.userCode}`);
          } else console.log(event.message);
        },
      };
      const session = createSubscription();
      try {
        await session.login(interaction, { getDeviceId: deviceId });
        const models = await session.list();
        if (values["list-models"]) {
          console.log(models.map((model) => `${model.id}\t${model.name}`).join("\n"));
          return 0;
        }
        const modelId =
          values.model ??
          (await interaction.prompt({
            type: "select",
            message: "Choose a subscription model for this single evaluation",
            options: models.map((model) => ({ id: model.id, label: model.name })),
            signal: cancellation.signal,
          }));
        selected = await session.select(modelId);
      } finally {
        terminal.close();
      }
    }
    const result = await evaluateFixture({
      fixture: fixture as NonNullable<typeof fixture>,
      mode: values.mode === "replay" ? "witness-replay" : "chatgpt-subscription",
      ...selected,
      signal: cancellation.signal,
    });
    console.log(
      JSON.stringify(
        {
          directory: result.directory,
          mode: result.summary.mode,
          projectId: result.summary.projectId,
          ref: result.summary.ref,
          status: result.summary.run.status,
          outcome: result.summary.run.outcome,
          valid: result.review.option.scorecard.valid,
          withinShellBounds: result.summary.withinShellBounds,
          passed: result.summary.passed,
          mainUnchanged: result.summary.mainUnchanged,
          acceptancePerformed: false,
        },
        null,
        2,
      ),
    );
    return result.summary.passed ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
