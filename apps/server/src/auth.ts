import type { ToolContext } from "@or1/tools";

export type LocalOwner = { token: string; context: ToolContext };

export function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}

function validToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9._~+/-]{32,4096}={0,2}$/.test(token);
}

function validNamespace(namespace: unknown): namespace is string {
  return typeof namespace === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(namespace);
}

/** No default credential; a namespace alone is a configuration error, not anonymous startup. */
export function localOwnerConfig(env: NodeJS.ProcessEnv, host: string) {
  if (env.OR1_OWNER_TOKEN === undefined && env.OR1_OWNER_NAMESPACE === undefined) return undefined;
  const namespace = env.OR1_OWNER_NAMESPACE ?? "local-owner";
  if (!validToken(env.OR1_OWNER_TOKEN) || !validNamespace(namespace) || !isLoopbackHost(host))
    throw new Error("Invalid local owner configuration; require a strong token and loopback host");
  return { token: env.OR1_OWNER_TOKEN, namespace };
}

/** Snapshot trusted credentials so later caller mutation cannot change an active server's role. */
export function validateOwner(owner: LocalOwner): LocalOwner {
  const context = owner?.context;
  if (
    !validToken(owner?.token) ||
    !context ||
    context.role !== "owner" ||
    !validNamespace(context.namespace) ||
    !context.store ||
    typeof context.store.execute !== "function" ||
    typeof context.store.readState !== "function" ||
    context.scope !== undefined ||
    context.runId !== undefined ||
    Object.keys(owner).some((key) => !["token", "context"].includes(key)) ||
    Object.keys(context).some((key) => !["role", "namespace", "store"].includes(key))
  )
    throw new Error("Invalid local owner credentials; require an unscoped owner context and store");
  return { token: owner.token, context: Object.freeze({ ...context }) };
}
