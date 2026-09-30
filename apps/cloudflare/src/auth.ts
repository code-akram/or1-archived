import { createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet, jwtVerify } from "jose";
import type { Env } from "./config.ts";
import { bytes, HttpError } from "./http.ts";

type KeyCache = {
  issuer: string;
  resolver: ReturnType<typeof createLocalJWKSet>;
  kids: Set<string>;
  fetchedAt: number;
};
// Keys only: authorization and memberships are re-evaluated on every request.
const caches = new Map<string, KeyCache>();
const pending = new Map<string, Promise<KeyCache>>();
const TTL = 5 * 60_000;
const REFRESH_COOLDOWN = 30_000;

async function keys(issuer: string, kid: string): Promise<KeyCache> {
  const cached = caches.get(issuer);
  const age = Date.now() - (cached?.fetchedAt ?? 0);
  if (cached && age < TTL && (cached.kids.has(kid) || age < REFRESH_COOLDOWN)) return cached;
  const existing = pending.get(issuer);
  if (existing) return existing;
  const loading = (async () => {
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Keys unavailable");
    const value = JSON.parse(
      new TextDecoder().decode(await bytes(response.body, 65_536)),
    ) as JSONWebKeySet;
    if (!Array.isArray(value.keys) || !value.keys.length || value.keys.length > 8)
      throw new Error("Invalid keys");
    const kids = new Set<string>();
    for (const key of value.keys) {
      if (
        key.kty !== "RSA" ||
        key.alg !== "RS256" ||
        key.use !== "sig" ||
        typeof key.kid !== "string" ||
        key.kid.length > 256 ||
        kids.has(key.kid) ||
        typeof key.n !== "string" ||
        typeof key.e !== "string" ||
        key.d !== undefined
      )
        throw new Error("Invalid key");
      kids.add(key.kid);
    }
    const entry = {
      issuer,
      resolver: createLocalJWKSet({ keys: value.keys }),
      kids,
      fetchedAt: Date.now(),
    };
    if (caches.size >= 4 && !caches.has(issuer))
      caches.delete(caches.keys().next().value as string);
    caches.set(issuer, entry);
    return entry;
  })();
  pending.set(issuer, loading);
  try {
    return await loading;
  } finally {
    pending.delete(issuer);
  }
}

export async function authenticate(
  request: Request,
  env: Env,
): Promise<{
  principalId: string;
  email: string;
  expiresAt: number;
}> {
  try {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token || token.length > 16_384) throw new Error("Missing token");
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256)
      throw new Error("Invalid header");
    const cache = await keys(env.ACCESS_ISSUER, header.kid);
    const { payload } = await jwtVerify(token, cache.resolver, {
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "email"],
    });
    const now = Date.now() / 1000;
    if (
      payload.type !== "app" ||
      typeof payload.sub !== "string" ||
      !payload.sub.trim() ||
      payload.sub.length > 256 ||
      typeof payload.email !== "string" ||
      payload.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+$/.test(payload.email) ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.iat) ||
      (payload.iat as number) > now ||
      (payload.iat as number) > (payload.exp as number) ||
      (payload.nbf !== undefined &&
        (!Number.isSafeInteger(payload.nbf) || payload.nbf > (payload.exp as number)))
    )
      throw new Error("Invalid claims");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([env.ACCESS_ISSUER, payload.sub])),
    );
    if (Date.now() >= (payload.exp as number) * 1000) throw new Error("Expired token");
    const principalId = `access-v1:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    return { principalId, email: payload.email, expiresAt: (payload.exp as number) * 1000 };
  } catch {
    // Never disclose tokens, claims, key errors, or authorization details.
    throw new HttpError(401, "unauthorized");
  }
}
