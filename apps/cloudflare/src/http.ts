import type { Env } from "./config.ts";

export const MAX_REQUEST_BYTES = 4096;
export const MAX_RESPONSE_BYTES = 2_097_152;

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function json(value: unknown, status = 200, principalId?: string): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES)
    throw new HttpError(413, "response_too_large");
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(principalId ? { "X-Or1-Principal-Id": principalId } : {}),
    },
  });
}

export function failure(error: unknown): Response {
  return error instanceof HttpError
    ? json({ ok: false, code: error.code }, error.status)
    : json({ ok: false, code: "unavailable" }, 503);
}

/** Count actual bytes, not an attacker-controlled Content-Length. Also used for JWKS. */
export async function bytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function apiChecks(request: Request, env: Env): "session" | "review" {
  const url = new URL(request.url);
  if (url.origin !== env.PUBLIC_ORIGIN) throw new HttpError(403, "forbidden");
  if (url.search) throw new HttpError(404, "not_found");
  const route =
    url.pathname === "/api/session"
      ? "session"
      : url.pathname === "/api/tools/review_option"
        ? "review"
        : undefined;
  if (!route) throw new HttpError(404, "not_found");
  if (request.method !== (route === "session" ? "GET" : "POST"))
    throw new HttpError(405, "method_not_allowed");
  const origin = request.headers.get("Origin");
  if ((route === "review" || origin !== null) && origin !== env.PUBLIC_ORIGIN)
    throw new HttpError(403, "forbidden");
  if (request.headers.has("Content-Encoding")) throw new HttpError(415, "unsupported_encoding");
  if (
    route === "review" &&
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")
  )
    throw new HttpError(415, "unsupported_media_type");
  return route;
}

export function parseInput(body: Uint8Array): { projectId: string; ref: string } {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.projectId !== "string" ||
      typeof value.ref !== "string"
    )
      throw new Error("Invalid input");
    return value;
  } catch {
    throw new HttpError(400, "invalid_input");
  }
}
