import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dataDir, openStore, type Store } from "@or1/store";
import type { ToolContext } from "@or1/tools";
import { localOwnerConfig } from "./auth.ts";
import { createHttpServer } from "./http.ts";
import { interactiveSubscription } from "./login.ts";
import { createStudio, type Studio } from "./studio.ts";

const HELP = `usage: pnpm studio [--model <id>] [--offline] [--port <port>]

Local owner studio on 127.0.0.1: define a shell and brief, generate options with parallel agents,
review them side by side and accept one into main. Data lives in OR1_DATA_DIR/or1.sqlite.

Agents use your personal ChatGPT subscription after an explicit interactive login in this terminal
(tokens stay in memory). --offline skips login: review and acceptance work, generation does not.
The owner token is OR1_OWNER_TOKEN, or a fresh random one per start. It is printed once, inside a
URL fragment that the browser never sends to the server. Runs have no wall-clock deadline.`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string" },
    offline: { type: "boolean" },
    port: { type: "string" },
    help: { type: "boolean" },
  },
  strict: true,
  allowPositionals: false,
});

let store: Store | undefined;
let studio: Studio | undefined;
try {
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  const port = Number(values.port ?? process.env.OR1_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const host = "127.0.0.1";
  const token = process.env.OR1_OWNER_TOKEN ?? randomBytes(32).toString("base64url");
  const owner = localOwnerConfig({ ...process.env, OR1_OWNER_TOKEN: token }, host);
  if (!owner) throw new Error("Owner configuration unavailable");
  const cancellation = new AbortController();
  process.once("SIGINT", () => cancellation.abort());
  const agent = values.offline
    ? undefined
    : await interactiveSubscription({
        signal: cancellation.signal,
        ...(values.model ? { modelId: values.model } : {}),
      });
  const directory = dataDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  store = openStore(join(directory, "or1.sqlite"));
  const context: ToolContext = { role: "owner", namespace: owner.namespace, store };
  studio = createStudio({
    store,
    owner: context,
    ...(agent?.kind === "selected"
      ? { agent: { model: agent.model, streamFn: agent.streamFn } }
      : {}),
  });
  const editor = fileURLToPath(new URL("../../editor/dist/", import.meta.url));
  const server = createHttpServer({
    owner: { token: owner.token, context },
    studio,
    ...(existsSync(join(editor, "index.html")) ? { editorRoot: editor } : {}),
  });
  const shutdown = async () => {
    server.closeAllConnections();
    server.close();
    // Cancels active runs; their committed revisions and ledgers stay inspectable.
    await studio?.close();
    store?.close();
  };
  process.removeAllListeners("SIGINT");
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown());
  server.on("error", () => {
    console.error("or1 studio failed to listen");
    process.exitCode = 1;
    void shutdown();
  });
  server.listen(port, host, () => {
    const model = agent?.kind === "selected" ? `${agent.model.provider}/${agent.model.id}` : null;
    console.log(`or1 studio on http://${host}:${port} · agent ${model ?? "offline"}`);
    if (!existsSync(join(editor, "index.html")))
      console.log(
        "Editor build missing: run `pnpm --filter @or1/editor build`, or use `pnpm studio`.",
      );
    console.log(
      `Open (token in the #fragment, never sent to the server): http://${host}:${port}/#token=${owner.token}`,
    );
    console.log(
      `Remote browser? Forward the port first: ssh -L ${port}:127.0.0.1:${port} <this host>`,
    );
  });
} catch {
  await studio?.close();
  store?.close();
  // Never log credential values, OAuth details or unexpected store/driver error details.
  console.error("or1 studio startup failed; check --help, login and the data directory");
  process.exitCode = 1;
}
