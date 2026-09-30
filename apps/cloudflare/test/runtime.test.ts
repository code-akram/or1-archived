import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { CloudSession, ReviewOptionResult } from "@or1/tools";
import { build } from "esbuild";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const origin = "https://or1.example.com";
const issuer = "https://synthetic.cloudflareaccess.com";
const projectId = "demo-workspace";
const config = {
  defaultProjectId: projectId,
  projects: [
    {
      projectId,
      label: "Synthetic demo",
      refs: ["option-a", "option-b", "incomplete"],
      members: [
        { email: "owner@example.com", membership: "owner" },
        { email: "viewer@example.com", membership: "viewer" },
      ],
    },
    {
      projectId: "other-project",
      label: "Other",
      refs: ["option"],
      members: [{ email: "owner@example.com", membership: "owner" }],
    },
  ],
};
let mf: Miniflare;
let persist: string;
let script: string;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let key: Awaited<ReturnType<typeof exportJWK>>;
let keyFetches = 0;
let jwksResponse: (() => Response) | undefined;

async function start(enabled = "true", projectConfig = config) {
  return new Miniflare({
    ...convertV4MiniflareOptions({
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: "runtime",
          modules: true,
          script,
          compatibilityDate: "2026-09-26",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            PUBLIC_ORIGIN: origin,
            ACCESS_ISSUER: issuer,
            ACCESS_AUD: "synthetic-audience",
            PROJECT_CONFIG: JSON.stringify(projectConfig),
            PROVISIONER_ENABLED: enabled,
          },
          durableObjects: {
            PROJECTS: { className: "Project", useSQLite: true },
            PROBE: { className: "Probe", useSQLite: true },
          },
          serviceBindings: { ASSETS: () => new Response("synthetic asset") },
          outboundService: (request) => {
            if (request.url !== `${issuer}/cdn-cgi/access/certs`)
              throw new Error("Unexpected outbound request");
            keyFetches++;
            if (jwksResponse) return jwksResponse();
            return new Response(
              JSON.stringify({ keys: [{ ...key, kid: "test-key", alg: "RS256", use: "sig" }] }),
            );
          },
        },
        {
          name: "private-client",
          modules: true,
          script: "export default {}",
          serviceBindings: { ADMIN: { name: "runtime", entrypoint: "Provisioner" } },
        },
      ],
    }),
    resourcePersistencePath: persist,
  });
}

async function seed() {
  const { ADMIN } = await mf.getBindings<{ ADMIN: { seedSyntheticDemo(): Promise<unknown> } }>(
    "private-client",
  );
  return ADMIN.seedSyntheticDemo();
}

async function token(
  overrides: Record<string, unknown> = {},
  signingPair = pair,
  kid = "test-key",
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: ["synthetic-audience"],
    sub: "viewer-sub",
    email: "viewer@example.com",
    type: "app",
    iat: now - 1,
    exp: now + 600,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .sign(signingPair.privateKey);
}

async function session(jwt?: string, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(`${origin}/api/session`, {
    headers: {
      ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
      ...headers,
    },
  });
}

async function review(
  jwt: string,
  ref = "option-a",
  input = projectId,
  headers: Record<string, string> = {},
) {
  return mf.dispatchFetch(`${origin}/api/tools/review_option`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Cf-Access-Jwt-Assertion": jwt,
      ...headers,
    },
    body: JSON.stringify({ projectId: input, ref }),
  });
}

async function tables() {
  const storage = await mf.unsafeGetDurableObjectStorage("runtime", "Project", { name: projectId });
  return storage.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE '__miniflare_%' ORDER BY name",
  );
}

async function snapshot() {
  const storage = await mf.unsafeGetDurableObjectStorage("runtime", "Project", { name: projectId });
  return {
    refs: await storage.exec("SELECT * FROM refs ORDER BY name"),
    outcomes: await storage.exec("SELECT * FROM request_outcomes ORDER BY request_id"),
    revisions: await storage.exec("SELECT * FROM revisions ORDER BY id"),
    runs: await storage.exec("SELECT * FROM runs ORDER BY id"),
  };
}

beforeAll(async () => {
  pair = await generateKeyPair("RS256", { extractable: true });
  key = await exportJWK(pair.publicKey);
  const dir = join(homedir(), ".local/share/or1/test-cloudflare");
  await mkdir(dir, { recursive: true });
  persist = await mkdtemp(join(dir, "native-"));
  const bundle = await build({
    entryPoints: [fileURLToPath(new NodeURL("./probe.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2024",
    external: ["cloudflare:workers", "node:*"],
    logLevel: "silent",
  });
  script = bundle.outputFiles[0]?.text ?? "";
  mf = await start();
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
  if (persist) await rm(persist, { recursive: true, force: true });
});

describe("native Worker and SQLite Project DO", () => {
  it("does not initialize the store for constructors, unauthenticated requests, or session", async () => {
    expect((await session()).status).toBe(401);
    const response = await session(await token());
    expect(keyFetches).toBe(1);
    expect(response.status).toBe(200);
    const value = (await response.json()) as CloudSession;
    expect(value).toMatchObject({
      mode: "cloud",
      projects: [
        { projectId, membership: "viewer", permissions: { canReview: true, canAccept: false } },
      ],
    });
    expect(value.projects).toHaveLength(1);
    expect(value.principalId).toBe(
      `access-v1:${createHash("sha256")
        .update(JSON.stringify([issuer, "viewer-sub"]))
        .digest("hex")}`,
    );
    expect(value.expiresAt).toBeGreaterThan(Date.now());
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(await tables()).toEqual([]);
  });

  it("rejects wrong methods/origins/authority/compression, admin and unknown API routes without SPA fallback", async () => {
    for (const path of [
      "/api/seed",
      "/api/tools/accept_option",
      "/api/runs",
      "/api/mcp",
      "/api/unknown",
      "/seed",
      "/accept",
      "/mcp",
      "/runs",
      "/run",
    ]) {
      const response = await mf.dispatchFetch(`${origin}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await mf.dispatchFetch(`${origin}/api/session`, { method: "POST" })).status).toBe(405);
    expect((await session(await token(), { Origin: "https://evil.example.com" })).status).toBe(403);
    expect((await mf.dispatchFetch("http://or1.example.com/api/session")).status).toBe(403);
    expect((await mf.dispatchFetch("https://or1.example.com:444/api/session")).status).toBe(403);
    expect((await mf.dispatchFetch("https://other.example.com/api/session")).status).toBe(403);
    expect((await review(await token(), "option-a", projectId, { Origin: "" })).status).toBe(403);
    expect(
      (await review(await token(), "option-a", projectId, { "Content-Encoding": "gzip" })).status,
    ).toBe(415);
    expect(
      (await review(await token(), "option-a", projectId, { "Content-Type": "text/plain" })).status,
    ).toBe(415);
    expect((await review(await token(), "option-a", "unconfigured")).status).toBe(404);
    expect(await mf.listDurableObjectIds("PROJECTS", "runtime")).toHaveLength(1);
    expect(await tables()).toEqual([]);
    expect(await (await mf.dispatchFetch(`${origin}/app`)).text()).toBe("synthetic asset");
  });

  it("enforces actual body bytes, malformed JSON, and missing POST Origin", async () => {
    const response = await mf.dispatchFetch(`${origin}/api/tools/review_option`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: `{"projectId":"${projectId}","ref":"${"é".repeat(2200)}"}`,
    });
    expect(response.status).toBe(413);
    expect(
      (
        await mf.dispatchFetch(`${origin}/api/tools/review_option`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await mf.dispatchFetch(`${origin}/api/tools/review_option`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });

  it("independently rejects bad JWT claims, service tokens, forged signatures and spoofed identity", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const overrides of [
      { iss: "https://wrong.cloudflareaccess.com" },
      { aud: "wrong" },
      { exp: now - 1 },
      { iat: now + 60 },
      { nbf: now + 60 },
      { sub: "" },
      { email: "" },
      { type: "org" },
      { exp: undefined },
      { iat: undefined },
      { sub: undefined },
      { email: undefined },
    ]) {
      const response = await session(await token(overrides), {
        "X-Or1-Principal-Id": "owner",
        "X-Or1-Role": "owner",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, code: "unauthorized" });
    }
    const wrongPair = await generateKeyPair("RS256");
    expect((await session(await token({}, wrongPair))).status).toBe(401);
    expect((await session(await token({}, pair, "unknown"))).status).toBe(401);
    expect((await session(await token({ email: "outsider@example.com" }))).status).toBe(403);
    expect((await review(await token({ email: "outsider@example.com" }))).status).toBe(403);
    expect(await tables()).toEqual([]);
    expect(keyFetches).toBe(1);
  });

  it("DO validates configured project and its own ID, not just the Worker route", async () => {
    const ns = await mf.getDurableObjectNamespace("PROJECTS", "runtime");
    const headers = { "Cf-Access-Jwt-Assertion": await token(), "X-Or1-Project-Id": projectId };
    expect(
      (await ns.get(ns.idFromName("wrong-id")).fetch(`${origin}/api/session`, { headers })).status,
    ).toBe(404);
    expect(
      (
        await ns.get(ns.idFromName(projectId)).fetch(`${origin}/api/session`, {
          headers: { ...headers, "X-Or1-Project-Id": "unconfigured" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await ns.get(ns.idFromName(projectId)).fetch(`${origin}/api/session`, {
          headers: { "X-Or1-Project-Id": projectId, "X-Or1-Principal-Id": "owner" },
        })
      ).status,
    ).toBe(401);
  });

  it("seeds only through private service RPC, reviews both memberships without any mutation", async () => {
    expect(await seed()).toEqual({ version: "cloud-demo-v1", projectId });
    const before = await snapshot();
    for (const email of ["owner@example.com", "viewer@example.com"]) {
      for (const ref of ["option-a", "option-b", "incomplete"]) {
        const response = await review(await token({ email }), ref, projectId, {
          "X-Or1-Principal-Id": "spoof",
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("X-Or1-Principal-Id")).toBe(
          `access-v1:${createHash("sha256")
            .update(JSON.stringify([issuer, "viewer-sub"]))
            .digest("hex")}`,
        );
        const value = (await response.json()) as ReviewOptionResult;
        expect(value).toMatchObject({ ok: true, projectId, ref });
        if (!value.ok) throw new Error("Review rejected");
        expect(value.option.model.walls).toHaveLength(4);
        expect(value.option.model.openings[0]?.offset).toBe(
          ref === "option-a" ? 800 : ref === "option-b" ? 2100 : 1200,
        );
        expect(value.eligibility.allowed).toBe(ref !== "incomplete");
      }
      expect((await review(await token({ email }), "option-a", "other-project")).status).toBe(
        email.startsWith("viewer") ? 403 : 200,
      );
    }
    expect(await snapshot()).toEqual(before);
    expect(await seed()).toEqual({ version: "cloud-demo-v1", projectId });
    expect(await snapshot()).toEqual(before);
  });

  it("exercises SQLite migrations, FK/immutable triggers, changes(), rollback and frozen replay inside workerd", async () => {
    const ns = await mf.getDurableObjectNamespace("PROBE", "runtime");
    const probe = ns.get(ns.idFromName("sql-probe")) as unknown as {
      check(): Promise<unknown>;
      unexpected(): Promise<unknown>;
    };
    expect(await probe.check()).toEqual({
      version: 3,
      missing: true,
      insertChanges: 1,
      updateChanges: 1,
      transactionRolledBack: true,
      foreignKey: true,
      immutable: true,
      evaluatorRollback: true,
      retryPreservedHead: true,
      reopenedHead: true,
    });
    const foreign = ns.get(ns.idFromName("unexpected")) as unknown as typeof probe;
    expect(await foreign.unexpected()).toEqual({ rejected: true, unchanged: true });
  });

  it("reopens persisted native DO state and disables provisioner after seeding", async () => {
    const before = await snapshot();
    await mf.dispose();
    mf = await start("false");
    expect((await review(await token())).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    await expect(seed()).rejects.toThrow("Provisioner disabled");
  });

  it("refreshes rotating JWKS, bounds unknown-kid refreshes, and never reuses stale authorization", async () => {
    const ns = await mf.getDurableObjectNamespace("PROBE", "runtime");
    const clock = ns.get(ns.idFromName("clock")) as unknown as {
      setClockOffset(ms: number): Promise<void>;
    };
    const rotated = await generateKeyPair("RS256", { extractable: true });
    const rotatedKey = {
      ...(await exportJWK(rotated.publicKey)),
      kid: "rotated",
      alg: "RS256",
      use: "sig",
    };
    const originalKey = { ...key, kid: "test-key", alg: "RS256", use: "sig" };
    const before = keyFetches;
    try {
      jwksResponse = () => new Response(JSON.stringify({ keys: [originalKey, rotatedKey] }));
      expect((await session(await token({}, rotated, "rotated"))).status).toBe(401);
      expect(keyFetches).toBe(before);
      await clock.setClockOffset(31_000);
      expect((await session(await token({}, rotated, "rotated"))).status).toBe(200);
      expect(keyFetches).toBe(before + 1);
      expect((await session(await token())).status).toBe(200);
      expect(
        (await session(await token({ email: "outsider@example.com" }, rotated, "rotated"))).status,
      ).toBe(403);
      jwksResponse = () => new Response(JSON.stringify({ keys: [rotatedKey] }));
      await clock.setClockOffset(332_000);
      expect((await session(await token())).status).toBe(401);
      expect((await session(await token({}, rotated, "rotated"))).status).toBe(200);
      expect(keyFetches).toBe(before + 2);
      jwksResponse = () => new Response("unavailable", { status: 503 });
      await clock.setClockOffset(633_000);
      const response = await session(
        await token({ exp: Math.floor(Date.now() / 1000) + 1200 }, rotated, "rotated"),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, code: "unauthorized" });
    } finally {
      await clock.setClockOffset(0);
      jwksResponse = undefined;
    }
  });
});
