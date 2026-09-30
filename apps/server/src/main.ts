import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir, openStore, type Store } from "@or1/store";
import { localOwnerConfig } from "./auth.ts";
import { createHttpServer } from "./http.ts";

const port = Number(process.env.OR1_PORT ?? 4310);
const host = process.env.OR1_HOST ?? "127.0.0.1";

let store: Store | undefined;
try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const owner = localOwnerConfig(process.env, host);
  if (owner) {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    store = openStore(join(dir, "or1.sqlite"));
  }
  const server = createHttpServer(
    owner && store
      ? {
          owner: {
            token: owner.token,
            context: { role: "owner", namespace: owner.namespace, store },
          },
        }
      : {},
  );
  server.once("close", () => store?.close());
  server.on("error", () => {
    console.error("or1 server failed to listen");
    process.exitCode = 1;
    server.close();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
  server.listen(port, host, () => {
    console.log(`or1 server listening on http://${host === "::1" ? "[::1]" : host}:${port}`);
  });
} catch {
  store?.close();
  // Never log credential values or unexpected store/driver error details.
  console.error("or1 server startup failed; check local owner configuration and data directory");
  process.exitCode = 1;
}
