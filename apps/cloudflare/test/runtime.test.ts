import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { CloudSession, ReviewOptionResult } from "@or1/tools";
import { build } from "esbuild";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
let assetFetches = 0;
let assetResponse: (() => Response | Promise<Response>) | undefined;
let requestOrigin = origin;

async function start(
  enabled = "true",
  projectConfig = config,
  bindings: Record<string, string> = {},
  persistencePath = persist,
) {
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
            ...bindings,
          },
          durableObjects: {
            PROJECTS: { className: "Project", useSQLite: true },
            PROBE: { className: "Probe", useSQLite: true },
          },
          serviceBindings: {
            ASSETS: () => {
              assetFetches++;
              return assetResponse?.() ?? new Response("synthetic asset");
            },
          },
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
    resourcePersistencePath: persistencePath,
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
  return mf.dispatchFetch(`${requestOrigin}/api/session`, {
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
  return mf.dispatchFetch(`${requestOrigin}/api/tools/review_option`, {
    method: "POST",
    headers: {
      Origin: requestOrigin,
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
    expect(value).not.toHaveProperty("authentication");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(await tables()).toEqual([]);
  });

  it("does not expose internal helpers or raw store authority through DO RPC", async () => {
    const ns = await mf.getDurableObjectNamespace("PROJECTS", "runtime");
    const stub = ns.get(ns.idFromName(projectId)) as unknown as {
      openStore(): Promise<unknown>;
      boundProject(projectId: string): Promise<unknown>;
    };
    // Miniflare may reject the proxy method lookup synchronously, before producing a promise.
    await expect(async () => stub.openStore()).rejects.toThrow('method "openStore"');
    await expect(async () => stub.boundProject(projectId)).rejects.toThrow('method "boundProject"');
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

describe("isolated development review bypass in native workerd", () => {
  const developmentOrigin = "https://or1-dev.orfloat.com";
  const developmentConfig = { ...config, projects: config.projects.slice(0, 1) };
  const principalId = "development-bypass:demo-workspace:v1";
  const now = 1_800_000_000_000;
  const expiresAt = now + 60_000;
  const bindings = {
    PUBLIC_ORIGIN: developmentOrigin,
    DEVELOPMENT_REVIEW_BYPASS: "true",
    DEPLOYMENT_ENVIRONMENT: "development",
    DEVELOPMENT_REVIEW_EXPIRES_AT: String(expiresAt),
  };
  let caseNumber = 0;
  let persistencePath: string;

  async function restart(
    overrides: Record<string, string | undefined> = {},
    projectConfig = developmentConfig,
  ) {
    await mf.dispose();
    const env: Record<string, string> = { ...bindings };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    mf = await start("true", projectConfig, env, persistencePath);
    const clock = await probe();
    await clock.setClock(now);
  }

  async function probe() {
    const ns = await mf.getDurableObjectNamespace("PROBE", "runtime");
    return ns.get(ns.idFromName("development-clock")) as unknown as {
      setClock(ms: number, expireOnRead?: number, expiredAt?: number): Promise<void>;
      expireAfterReview(ms: number): Promise<void>;
      lastReviewContext(): Promise<unknown>;
      request(
        target: string,
        url: string,
        init: { method?: string; headers?: Record<string, string>; body?: string },
      ): Promise<{ status: number; body: string }>;
    };
  }

  async function direct() {
    const ns = await mf.getDurableObjectNamespace("PROJECTS", "runtime");
    return ns.get(ns.idFromName(projectId));
  }

  beforeEach(async () => {
    requestOrigin = developmentOrigin;
    persistencePath = join(persist, `development-${++caseNumber}`);
    assetResponse = undefined;
    await restart();
  });

  it("returns the anonymous viewer marker and fixed deadline without initializing SQL or fetching JWKS", async () => {
    const before = keyFetches;
    for (const jwt of [undefined, "malformed", await token({ email: "owner@example.com" })]) {
      const response = await session(jwt, { "X-Or1-Role": "owner", "X-Or1-Principal-Id": "owner" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        mode: "cloud",
        authentication: "development-bypass",
        principalId,
        expiresAt,
        projects: [
          {
            projectId,
            label: "Synthetic demo",
            membership: "viewer",
            refs: ["option-a", "option-b", "incomplete"],
            permissions: { canReview: true, canAccept: false },
          },
        ],
      });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(keyFetches).toBe(before);
    expect(await tables()).toEqual([]);
    // A development viewer is not a fabricated member/owner email.
    await restart(
      {},
      {
        ...developmentConfig,
        projects: developmentConfig.projects.map((project) => ({ ...project, members: [] })),
      },
    );
    expect((await session()).status).toBe(200);
    expect(await tables()).toEqual([]);
    await seed();
    expect(await (await review("")).json()).toMatchObject({ ok: true, projectId, ref: "option-a" });
    expect(await (await probe()).lastReviewContext()).toEqual({
      namespace: principalId,
      role: "external",
      reviewProjectId: projectId,
    });
  });

  it("reviews anonymously with external capability, ignores owner credentials, and leaves snapshots unchanged", async () => {
    await seed();
    const before = await snapshot();
    const fetches = keyFetches;
    for (const jwt of ["", "malformed", await token({ email: "owner@example.com" })]) {
      for (const ref of ["option-a", "option-b", "incomplete"]) {
        const response = await review(jwt, ref, projectId, {
          "X-Or1-Role": "owner",
          "X-Or1-Principal-Id": "owner",
          "X-Or1-Project-Id": "other-project",
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("X-Or1-Principal-Id")).toBe(principalId);
        const value = (await response.json()) as ReviewOptionResult;
        expect(value).toMatchObject({ ok: true, projectId, ref });
        if (!value.ok) throw new Error("Development review rejected");
        expect(value.option.model.openings[0]?.offset).toBe(
          ref === "option-a" ? 800 : ref === "option-b" ? 2100 : 1200,
        );
        expect(value.eligibility.allowed).toBe(ref !== "incomplete");
        expect(await (await probe()).lastReviewContext()).toEqual({
          namespace: principalId,
          role: "external",
          reviewProjectId: projectId,
        });
      }
    }
    expect(keyFetches).toBe(fetches);
    expect((await review("", "option-a", "other-project")).status).toBe(404);
    for (const path of [
      "/api/seed",
      "/api/tools/accept_option",
      "/api/runs",
      "/seed",
      "/accept",
      "/run",
      "/tools/apply_changes",
    ]) {
      expect((await mf.dispatchFetch(`${developmentOrigin}${path}`)).status).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("fails closed for malformed flags, environments, origins, project configs and deadlines even with an owner JWT", async () => {
    const jwt = await token({ email: "owner@example.com", exp: Math.floor(now / 1000) + 600 });
    const fetches = keyFetches;
    const assets = assetFetches;
    for (const overrides of [
      { DEVELOPMENT_REVIEW_BYPASS: "TRUE" },
      { DEVELOPMENT_REVIEW_BYPASS: "" },
      { DEVELOPMENT_REVIEW_BYPASS: "1" },
      { DEPLOYMENT_ENVIRONMENT: "production" },
      { DEPLOYMENT_ENVIRONMENT: "" },
      { DEPLOYMENT_ENVIRONMENT: undefined },
      { PUBLIC_ORIGIN: "https://or1.orfloat.com" },
      { PUBLIC_ORIGIN: `${developmentOrigin}/` },
      { PUBLIC_ORIGIN: "http://or1-dev.orfloat.com" },
      { DEVELOPMENT_REVIEW_EXPIRES_AT: "" },
      { DEVELOPMENT_REVIEW_EXPIRES_AT: undefined },
      { DEVELOPMENT_REVIEW_EXPIRES_AT: "1800000060000.0" },
      { DEVELOPMENT_REVIEW_EXPIRES_AT: "1.8e12" },
      { DEVELOPMENT_REVIEW_EXPIRES_AT: " 1800000060000" },
      { DEVELOPMENT_REVIEW_EXPIRES_AT: "-1" },
      { DEVELOPMENT_REVIEW_EXPIRES_AT: "9007199254740992" },
      { PROJECT_CONFIG: "{" },
      { PROJECT_CONFIG: JSON.stringify(config) },
      {
        PROJECT_CONFIG: JSON.stringify({ ...developmentConfig, defaultProjectId: "other-project" }),
      },
      {
        PROJECT_CONFIG: JSON.stringify({
          defaultProjectId: "other-project",
          projects: [config.projects[1]],
        }),
      },
    ]) {
      await restart(overrides);
      for (const response of [
        await session(jwt),
        await mf.dispatchFetch(`${developmentOrigin}/app`),
      ]) {
        expect(response.status).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
      expect(
        (
          await (
            await direct()
          ).fetch(`${developmentOrigin}/api/session`, {
            headers: { "X-Or1-Project-Id": projectId, "Cf-Access-Jwt-Assertion": jwt },
          })
        ).status,
      ).not.toBe(200);
      expect(await tables()).toEqual([]);
    }
    expect(keyFetches).toBe(fetches);
    expect(assetFetches).toBe(assets);
  }, 30_000);

  it("enforces both deadline endpoints and rechecks warm Worker and DO instances at exact expiry", async () => {
    for (const delta of [-1, 0, 1, 7 * 24 * 60 * 60_000, 7 * 24 * 60 * 60_000 + 1]) {
      await restart({ DEVELOPMENT_REVIEW_EXPIRES_AT: String(now + delta) });
      const expected = delta > 0 && delta <= 604_800_000 ? 200 : 401;
      expect((await session()).status).toBe(expected);
      expect(
        (
          await (
            await probe()
          ).request(projectId, `${developmentOrigin}/api/session`, {
            headers: { "X-Or1-Project-Id": projectId },
          })
        ).status,
      ).toBe(expected);
    }
    await restart();
    const clock = await probe();
    await clock.setClock(expiresAt - 1);
    expect((await session()).status).toBe(200);
    const stub = await direct();
    expect(
      (
        await stub.fetch(`${developmentOrigin}/api/session`, {
          headers: { "X-Or1-Project-Id": projectId },
        })
      ).status,
    ).toBe(200);
    const assets = assetFetches;
    await clock.setClock(expiresAt);
    expect((await session(await token({ email: "owner@example.com" }))).status).toBe(401);
    expect(
      (
        await stub.fetch(`${developmentOrigin}/api/session`, {
          headers: { "X-Or1-Project-Id": projectId },
        })
      ).status,
    ).toBe(401);
    expect((await mf.dispatchFetch(`${developmentOrigin}/app`)).status).toBe(401);
    expect(assetFetches).toBe(assets);
    expect(await tables()).toEqual([]);
  });

  it("keeps exact request origin checks and rejects direct DO project/identity spoofing", async () => {
    for (const wrongOrigin of [
      origin,
      "http://or1-dev.orfloat.com",
      "https://or1-dev.orfloat.com:444",
      "https://or1-dev.orfloat.com.evil.example",
    ]) {
      expect((await mf.dispatchFetch(`${wrongOrigin}/api/session`)).status).toBe(403);
      expect((await mf.dispatchFetch(`${wrongOrigin}/app`)).status).toBe(403);
    }
    for (const wrongOrigin of [origin, "null"]) {
      expect((await session(undefined, { Origin: wrongOrigin })).status).toBe(403);
      expect((await review("", "option-a", projectId, { Origin: wrongOrigin })).status).toBe(403);
      expect(
        (await mf.dispatchFetch(`${developmentOrigin}/app`, { headers: { Origin: wrongOrigin } }))
          .status,
      ).toBe(403);
    }
    const native = await probe();
    for (const path of ["/api/session", "/app"]) {
      expect(
        (
          await native.request("worker", `${developmentOrigin}${path}`, {
            headers: { Origin: "" },
          })
        ).status,
      ).toBe(403);
    }
    const ns = await mf.getDurableObjectNamespace("PROJECTS", "runtime");
    const headers = { "X-Or1-Project-Id": projectId, "X-Or1-Role": "owner" };
    expect(
      (
        await ns
          .get(ns.idFromName("other-project"))
          .fetch(`${developmentOrigin}/api/session`, { headers })
      ).status,
    ).toBe(404);
    const stub = await direct();
    expect(
      (
        await stub.fetch(`${developmentOrigin}/api/session`, {
          headers: { ...headers, "X-Or1-Project-Id": "other-project" },
        })
      ).status,
    ).toBe(404);
    expect((await stub.fetch(`${origin}/api/session`, { headers })).status).toBe(403);
    expect(
      (
        await native.request(projectId, `${developmentOrigin}/api/tools/review_option`, {
          method: "POST",
          headers: { ...headers, Origin: developmentOrigin, "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: "other-project", ref: "option-a" }),
        })
      ).status,
    ).toBe(404);
    const rpc = stub as unknown as {
      openStore(): Promise<unknown>;
      boundProject(id: string): Promise<unknown>;
    };
    await expect(async () => rpc.openStore()).rejects.toThrow('method "openStore"');
    await expect(async () => rpc.boundProject(projectId)).rejects.toThrow('method "boundProject"');
    expect(await tables()).toEqual([]);
  });

  it("rechecks after awaited session and review work in both DO and Worker", async () => {
    const clock = await probe();
    const stub = await direct();
    // Direct session: entry is read 1, post-body/session is read 2.
    await clock.setClock(now, 2, expiresAt);
    expect(
      (
        await stub.fetch(`${developmentOrigin}/api/session`, {
          headers: { "X-Or1-Project-Id": projectId },
        })
      ).status,
    ).toBe(401);
    // Worker session: Worker entry, DO entry, DO success, then Worker post-await.
    await clock.setClock(now, 4, expiresAt);
    expect((await session()).status).toBe(401);
    await clock.setClock(now);
    await seed();
    const before = await snapshot();
    // Worker review: its post-await deadline follows both DO deadline reads and token expiry.
    await clock.setClock(now, 5, expiresAt);
    expect((await review("")).status).toBe(401);
    await clock.setClock(now);
    // Review succeeds in the real registry, then the test-only observer crosses expiry.
    await clock.expireAfterReview(expiresAt);
    expect(
      (
        await clock.request(projectId, `${developmentOrigin}/api/tools/review_option`, {
          method: "POST",
          headers: {
            "X-Or1-Project-Id": projectId,
            Origin: developmentOrigin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ projectId, ref: "option-a" }),
        })
      ).status,
    ).toBe(401);
    expect(await clock.lastReviewContext()).toEqual({
      namespace: principalId,
      role: "external",
      reviewProjectId: projectId,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("makes successful assets no-store and rejects expiry during asset work without SPA fallback", async () => {
    const clock = await probe();
    assetResponse = () =>
      new Response("synthetic asset", { headers: { "Cache-Control": "public, max-age=3600" } });
    for (const method of ["GET", "HEAD"]) {
      const response = await mf.dispatchFetch(`${developmentOrigin}/app`, { method });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const assets = assetFetches;
    assetResponse = async () => {
      await clock.setClock(expiresAt);
      return new Response("must not escape after expiry");
    };
    const response = await mf.dispatchFetch(`${developmentOrigin}/app`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, code: "unauthorized" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(assetFetches).toBe(assets + 1);
    expect((await mf.dispatchFetch(`${developmentOrigin}/app`)).status).toBe(401);
    expect(assetFetches).toBe(assets + 1);
  });

  it("keeps false/absent mode JWT-only and ignores project JSON or header mode injection", async () => {
    for (const flag of [undefined, "false"]) {
      await restart({ DEVELOPMENT_REVIEW_BYPASS: flag, DEVELOPMENT_REVIEW_EXPIRES_AT: "invalid" }, {
        ...developmentConfig,
        developmentReviewExpiresAt: expiresAt,
      } as typeof developmentConfig);
      await (await probe()).setClock(Date.now());
      const fetches = keyFetches;
      expect(
        (await session(undefined, { "X-Or1-Authentication": "development-bypass" })).status,
      ).toBe(401);
      const response = await session(await token({ email: "owner@example.com" }));
      expect(response.status).toBe(200);
      const value = (await response.json()) as CloudSession;
      expect(value).not.toHaveProperty("authentication");
      expect(value.principalId).toMatch(/^access-v1:/);
      expect(value.projects[0]?.membership).toBe("owner");
      expect(keyFetches).toBe(fetches + 1);
    }
  });
});
