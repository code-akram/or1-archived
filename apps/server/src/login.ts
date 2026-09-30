import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AuthInteraction, Model } from "@earendil-works/pi-ai";
import { createSubscription } from "./subscription.ts";

/** Nonsecret stable installation identity. OAuth access/refresh tokens are never written here. */
export function deviceId(): string {
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

/**
 * Explicit, interactive ChatGPT OAuth in the operator's own terminal. Never unattended, never a
 * cached third-party secret or paid-key fallback. Tokens stay in this process's memory.
 */
export async function interactiveSubscription(options: {
  signal: AbortSignal;
  modelId?: string;
  listOnly?: boolean;
}): Promise<
  | { kind: "selected"; model: Model<Api>; streamFn: StreamFn }
  | { kind: "listed"; models: { id: string; name: string }[] }
> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Subscription login requires an interactive terminal");
  console.log("Personal ChatGPT subscription: agent runs consume your subscription allowance.");
  console.log("The provider output-token cap is omitted; runner budgets are runaway guards only.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const loginSignal = AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60_000)]);
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
        prompt.options.find((option) => option.id === answer) ?? prompt.options[Number(answer) - 1];
      if (!choice) throw new Error("Invalid selection");
      return choice.id;
    },
    notify(event) {
      if (event.type === "auth_url") {
        console.log(`Authorize in your own browser: ${event.url}`);
        console.log(
          "If the loopback callback cannot reach this machine, paste its full redirect URL in this terminal—not chat.",
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
    if (options.listOnly) return { kind: "listed", models };
    const modelId =
      options.modelId ??
      (await interaction.prompt({
        type: "select",
        message: "Choose a subscription model for agent runs",
        options: models.map((model) => ({ id: model.id, label: model.name })),
        signal: options.signal,
      }));
    return { kind: "selected", ...(await session.select(modelId)) };
  } finally {
    terminal.close();
  }
}
