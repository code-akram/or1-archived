import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { MAX_TOOL_INPUT_BYTES, tools } from "@or1/tools";
import { isLoopbackHost, type LocalOwner, validateOwner } from "./auth.ts";
import { createMcpNodeHandler } from "./mcp.ts";
import type { Studio } from "./studio.ts";

export type HttpOptions = {
  owner?: LocalOwner;
  /** Explicit browser allowlist override; only canonical HTTP loopback origins are permitted. */
  allowedOrigins?: readonly string[];
  /** Owner-only agent orchestration on the owner's store. Requires owner credentials. */
  studio?: Studio;
  /**
   * Built editor directory served same-origin at `/`, with its `/api/*` calls routed to the API.
   * Static files are public build output and carry no credentials or project data.
   */
  editorRoot?: string;
};

/** Registry tools reachable with the local owner credential over HTTP. */
const OWNER_HTTP_TOOLS = new Set([
  "review_option",
  "accept_option",
  "create_project",
  "set_brief",
  "list_projects",
  "project_overview",
]);
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

class TransportError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(status >= 400 ? { connection: "close" } : {}),
  });
  res.end(JSON.stringify(data));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1] ?? "");
  if (values.length > 1)
    throw new TransportError(name === "authorization" ? 401 : 400, "ambiguous_header");
  return values[0];
}

function localAuthorities(port: number): string[] {
  return ["127.0.0.1", "localhost", "[::1]"].map((host) => `${host}:${port}`);
}

function checkLocalRequest(req: IncomingMessage, origins?: readonly string[]): void {
  const port = req.socket.localPort;
  if (
    port === undefined ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.localAddress ?? "") ||
    ![...localAuthorities(port), ...localAuthorities(4310)].includes(header(req, "host") ?? "")
  )
    throw new TransportError(403, "invalid_host");
  const origin = header(req, "origin");
  const allowed = origins ?? [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...[...localAuthorities(port), ...localAuthorities(4310)].map((host) => `http://${host}`),
  ];
  if (origin !== undefined && !allowed.includes(origin))
    throw new TransportError(403, "invalid_origin");
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: TransportError) => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      // Keep the error listener until the stream closes, including after a response to an abort.
      if (error) reject(error);
    };
    const onAborted = () => finish(new TransportError(400, "aborted_body"));
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_TOOL_INPUT_BYTES) {
        req.pause();
        finish(new TransportError(413, "body_too_large"));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      finish();
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(text));
      } catch {
        reject(new TransportError(400, "invalid_json"));
      }
    };
    const timer = setTimeout(() => finish(new TransportError(408, "body_timeout")), 10_000);
    timer.unref();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.on("error", onAborted);
  });
}

/** Local owner HTTP is opt-in; MCP always gets a separate anonymous external context. */
export function createHttpServer(options: HttpOptions = {}): Server {
  const owner = options.owner === undefined ? undefined : validateOwner(options.owner);
  const origins = options.allowedOrigins === undefined ? undefined : [...options.allowedOrigins];
  if (origins !== undefined) {
    if (!owner) throw new Error("Local owner origins require owner credentials");
    for (const origin of origins) {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        url.protocol !== "http:" ||
        !isLoopbackHost(url.hostname === "[::1]" ? "::1" : url.hostname)
      )
        throw new Error("Invalid local owner origin");
    }
  }
  const credential = owner ? createHash("sha256").update(owner.token).digest() : undefined;
  const studio = options.studio;
  if (studio && !owner) throw new Error("Studio routes require owner credentials");
  const editorRoot =
    options.editorRoot === undefined ? undefined : realpathSync(options.editorRoot);
  /** Serves only regular files inside the build directory; unknown routes fall back to the SPA. */
  function serveEditor(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (!editorRoot) return false;
    try {
      checkLocalRequest(req, origins);
      let path = resolve(editorRoot, `.${decodeURIComponent(pathname)}`);
      if (path !== editorRoot && !path.startsWith(`${editorRoot}${sep}`)) return false;
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
        if (extname(pathname)) return false;
        path = join(editorRoot, "index.html");
      }
      const real = realpathSync(path);
      if (!real.startsWith(`${editorRoot}${sep}`)) return false;
      const body = readFileSync(real);
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(real)] ?? "application/octet-stream",
        "cache-control": real.endsWith("index.html") ? "no-store" : "public, max-age=3600",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    } catch (error) {
      if (error instanceof TransportError) {
        json(res, error.status, { error: error.message });
        return true;
      }
      return false;
    }
  }
  const mcp = createMcpNodeHandler();
  async function ownerRoute(
    req: IncomingMessage,
    res: ServerResponse,
    handle: (params: unknown) => Promise<unknown> | unknown,
  ) {
    try {
      const authorization = header(req, "authorization");
      const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/i.exec(authorization ?? "");
      if (
        !match?.[1] ||
        !credential ||
        !timingSafeEqual(createHash("sha256").update(match[1]).digest(), credential)
      )
        throw new TransportError(401, "unauthorized");
      checkLocalRequest(req, origins);
      if (req.method !== "POST") throw new TransportError(405, "method_not_allowed");
      if (req.url?.includes("?")) throw new TransportError(400, "query_not_allowed");
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, "content-type") ?? ""))
        throw new TransportError(415, "unsupported_content_type");
      if (header(req, "content-encoding") !== undefined)
        throw new TransportError(415, "unsupported_content_encoding");
      const length = header(req, "content-length");
      if (length !== undefined && Number(length) > MAX_TOOL_INPUT_BYTES)
        throw new TransportError(413, "body_too_large");
      const params = await readJson(req);
      json(res, 200, await handle(params));
    } catch (error) {
      if (!res.destroyed && !res.headersSent)
        json(res, error instanceof TransportError ? error.status : 500, {
          error: error instanceof TransportError ? error.message : "internal_error",
        });
    }
  }
  const server = createServer((req, res) => {
    // Accept only origin-form paths; never use untrusted Host or forwarded headers as a base URL.
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
      json(res, 400, { error: "invalid_url" });
      return;
    }
    let pathname = req.url.split("?", 1)[0] ?? "/";
    // The same-origin editor addresses the API under /api, like the Vite development proxy.
    const api = pathname === "/api" || pathname.startsWith("/api/");
    if (editorRoot && api) pathname = pathname.slice("/api".length) || "/";
    const toolName = pathname.startsWith("/tools/") ? pathname.slice("/tools/".length) : undefined;
    if (owner && toolName && OWNER_HTTP_TOOLS.has(toolName)) {
      const tool = tools.find((tool) => tool.name === toolName);
      void ownerRoute(req, res, async (params) => {
        if (!tool) throw new TransportError(503, "tool_unavailable");
        return (await tool.execute(params, owner.context)).data;
      });
      return;
    }
    if (owner && studio && pathname === "/studio/status") {
      void ownerRoute(req, res, () => studio.status());
      return;
    }
    if (owner && studio && pathname === "/studio/generate") {
      void ownerRoute(req, res, (params) => studio.generate(params));
      return;
    }
    if (owner && studio && pathname === "/studio/cancel") {
      void ownerRoute(req, res, (params) => studio.cancel(params));
      return;
    }
    if (pathname === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("event: hello\ndata: {}\n\n");
      return;
    }
    if (pathname === "/mcp") {
      // The SDK's duck type assumes exactOptionalPropertyTypes is off; IncomingMessage satisfies it at runtime.
      void mcp(req as NodeIncomingMessageLike, res).catch(() => {
        if (!res.destroyed && !res.headersSent) json(res, 500, { error: "internal_error" });
      });
      return;
    }
    // API misses stay JSON 404s (the editor detects local mode from GET /api/session).
    if (
      editorRoot &&
      !api &&
      (req.method === "GET" || req.method === "HEAD") &&
      serveEditor(req, res, pathname)
    )
      return;
    json(res, 404, { error: "not_found" });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.setTimeout(15_000);
  return server;
}
