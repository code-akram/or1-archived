import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Op, OpsSchema } from "@or1/core";
import { Value } from "typebox/value";
import { evaluateFixture, loadFixture, readFixtureJson, replayWitness } from "./evaluation.ts";
import { interactiveSubscription } from "./login.ts";

const HELP = `usage: pnpm eval --fixture <fixture-id> --mode <replay|subscription> [--model <id>]
       pnpm eval --mode subscription --list-models

Replay is a disclosed deterministic witness check, NOT agent design-quality evidence.
Subscription mode requires interactive human ChatGPT OAuth login and uses no witness or API key.
Credentials stay in process memory; no paid API fallback or public run-start route exists.
Live runs have no wall-clock deadline (Ctrl+C cancels) and end once the option passes every hard gate.
ChatGPT subscription shaping omits the provider output token cap: runner budgets are runaway guards,
NOT a hard provider usage or billing limit.
Each run writes a new private database, review and ledger under OR1_DATA_DIR/eval-runs.
Main is not automatically accepted or modified. Cloudflare's public demo remains read-only.`;

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
      const subscription = await interactiveSubscription({
        signal: cancellation.signal,
        ...(values.model ? { modelId: values.model } : {}),
        ...(values["list-models"] ? { listOnly: true } : {}),
      });
      if (subscription.kind === "listed") {
        console.log(subscription.models.map((model) => `${model.id}\t${model.name}`).join("\n"));
        return 0;
      }
      selected = { model: subscription.model, streamFn: subscription.streamFn };
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
