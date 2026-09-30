import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createStore, type PortableStore } from "@or1/store/portable";
import { type CloudSession, reviewOption } from "@or1/tools";
import { authenticate } from "./auth.ts";
import { configuration, type Env } from "./config.ts";
import { DEMO_PROJECT_ID, seedDemoV1 } from "./demo.ts";
import {
  apiChecks,
  bytes,
  failure,
  HttpError,
  json,
  MAX_REQUEST_BYTES,
  parseInput,
} from "./http.ts";
import { sqlDriver } from "./sql.ts";

export class Project extends DurableObject<Env> {
  private store?: PortableStore;

  private boundProject(projectId: string) {
    const config = configuration(this.env);
    const project = config.projects.find((entry) => entry.projectId === projectId);
    if (!project || !this.ctx.id.equals(this.env.PROJECTS.idFromName(project.projectId)))
      throw new HttpError(404, "not_found");
    return { config, project };
  }

  private openStore(): PortableStore {
    this.store ??= createStore(sqlDriver(this.ctx.storage));
    return this.store;
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const route = apiChecks(request, this.env);
      const { config, project } = this.boundProject(request.headers.get("X-Or1-Project-Id") ?? "");
      const body = await bytes(request.body, MAX_REQUEST_BYTES);
      if (route === "session" && body.length) throw new HttpError(400, "invalid_input");
      const identity = await authenticate(request, this.env);
      if (route === "session") {
        if (project.projectId !== config.defaultProjectId) throw new HttpError(404, "not_found");
        const projects: CloudSession["projects"] = config.projects.flatMap((entry) => {
          const member = entry.members.find((member) => member.email === identity.email);
          return member
            ? [
                {
                  projectId: entry.projectId,
                  label: entry.label,
                  membership: member.membership,
                  refs: entry.refs,
                  permissions: { canReview: true as const, canAccept: false as const },
                },
              ]
            : [];
        });
        if (!projects.length) throw new HttpError(403, "forbidden");
        const session: CloudSession = {
          mode: "cloud",
          principalId: identity.principalId,
          expiresAt: identity.expiresAt,
          projects,
        };
        return json(session);
      }
      const member = project.members.find((member) => member.email === identity.email);
      if (!member) throw new HttpError(403, "forbidden");
      const input = parseInput(body);
      if (input.projectId !== project.projectId) throw new HttpError(404, "not_found");
      // The capability is restrictive even for owners. No browser actor can accept or mutate.
      const result = await reviewOption.execute(input, {
        store: this.openStore(),
        namespace: identity.principalId,
        role: member.membership === "owner" ? "owner" : "external",
        reviewProjectId: project.projectId,
      });
      // Authentication may have expired while a JWKS request was in flight; fail closed.
      if (Date.now() >= identity.expiresAt) throw new HttpError(401, "unauthorized");
      return json(result.data, 200, identity.principalId);
    } catch (error) {
      return failure(error);
    }
  }

  /** Only a private service-binding entrypoint calls this RPC; fetch has no admin route. */
  async seedSyntheticDemoV1(): Promise<{ version: string; projectId: string }> {
    if (this.env.PROVISIONER_ENABLED !== "true") throw new Error("Provisioner disabled");
    this.boundProject(DEMO_PROJECT_ID);
    return this.ctx.blockConcurrencyWhile(() => seedDemoV1(this.openStore()));
  }
}

export class Provisioner extends WorkerEntrypoint<Env> {
  async seedSyntheticDemo(): Promise<{ version: string; projectId: string }> {
    if (this.env.PROVISIONER_ENABLED !== "true") throw new Error("Provisioner disabled");
    const config = configuration(this.env);
    if (!config.projects.some((project) => project.projectId === DEMO_PROJECT_ID))
      throw new Error("Synthetic project is not configured");
    const stub = this.env.PROJECTS.get(
      this.env.PROJECTS.idFromName(DEMO_PROJECT_ID),
    ) as DurableObjectStub<Project>;
    return stub.seedSyntheticDemoV1();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const config = configuration(env);
      const url = new URL(request.url);
      if (url.origin !== env.PUBLIC_ORIGIN) throw new HttpError(403, "forbidden");
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const route = apiChecks(request, env);
        const body = await bytes(request.body, MAX_REQUEST_BYTES);
        if (route === "session" && body.length) throw new HttpError(400, "invalid_input");
        const projectId =
          route === "session" ? config.defaultProjectId : parseInput(body).projectId;
        if (!config.projects.some((project) => project.projectId === projectId))
          throw new HttpError(404, "not_found");
        const headers = new Headers();
        for (const name of ["Cf-Access-Jwt-Assertion", "Origin", "Content-Type"]) {
          const value = request.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        headers.set("X-Or1-Project-Id", projectId);
        const forwarded = new Request(request.url, {
          method: request.method,
          headers,
          ...(route === "review" ? { body } : {}),
        });
        // Return the bounded DO response directly; do not parse/copy a potentially large review.
        return await env.PROJECTS.get(env.PROJECTS.idFromName(projectId)).fetch(forwarded);
      }
      if (/^\/(?:accept|seed|mcp|runs?|tools)(?:\/|$)/i.test(url.pathname))
        throw new HttpError(404, "not_found");
      if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "method_not_allowed");
      const response = await env.ASSETS.fetch(request);
      if (response.status < 400) return response;
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Env>;
