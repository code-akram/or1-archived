import { afterEach, describe, expect, it, vi } from "vitest";
import { compileProject, PRESETS } from "../src/draft.ts";
import { StudioSession } from "../src/studio-session.ts";

type Handler = (body: unknown) => unknown;
const token = "synthetic-owner-credential-0123456789abcdef";

function server(routes: Record<string, Handler>) {
  const calls: { path: string; body: unknown; authorization: string | null }[] = [];
  const fetcher = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({
      path: String(path),
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const handler = routes[String(path)];
    if (!handler) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const status = {
  ok: true,
  agent: { provider: "openai", id: "m", name: "M" },
  activeRuns: [],
  strategies: [],
};
const overview = (runStatus: string) => ({
  ok: true,
  projectId: "b",
  briefVersion: 1,
  brief: { schemaVersion: 2, rooms: [], constraints: [] },
  main: {},
  options: [{ ref: "option-1", stale: false, plan: {}, runs: [{ id: "r", status: runStatus }] }],
});

afterEach(() => vi.useRealTimers());

describe("studio session", () => {
  it("connects with the review token, selects the newest project and polls only while runs are live", async () => {
    vi.useFakeTimers();
    let runStatus = "running";
    const { fetcher, calls } = server({
      "/api/studio/status": () => status,
      "/api/tools/list_projects": () => ({
        ok: true,
        projects: [
          { projectId: "a", createdAt: "1", name: "A", options: 0 },
          { projectId: "b", createdAt: "2", name: "B", options: 1 },
        ],
      }),
      "/api/tools/project_overview": () => overview(runStatus),
    });
    const studio = new StudioSession(() => token, fetcher, 1000);
    await studio.connect();
    expect(studio.getSnapshot()).toMatchObject({ projectId: "b", composing: false });
    expect(calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
    const overviews = () => calls.filter((c) => c.path === "/api/tools/project_overview").length;
    expect(overviews()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(overviews()).toBe(2);
    runStatus = "done";
    await vi.advanceTimersByTimeAsync(1000);
    expect(overviews()).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(overviews()).toBe(3);
  });

  it("stops polling and forgets data on disconnect", async () => {
    vi.useFakeTimers();
    const { fetcher, calls } = server({
      "/api/studio/status": () => status,
      "/api/tools/list_projects": () => ({
        ok: true,
        projects: [{ projectId: "b", createdAt: "2", name: "B", options: 1 }],
      }),
      "/api/tools/project_overview": () => overview("running"),
    });
    const studio = new StudioSession(() => token, fetcher, 1000);
    await studio.connect();
    studio.disconnect();
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(before);
    expect(studio.getSnapshot()).toMatchObject({ status: null, overview: undefined, projects: [] });
  });

  it("makes no request without a token and opens the composer for an empty store", async () => {
    const { fetcher, calls } = server({
      "/api/studio/status": () => ({ ...status, agent: null }),
      "/api/tools/list_projects": () => ({ ok: true, projects: [] }),
    });
    let current = "";
    const studio = new StudioSession(() => current, fetcher);
    await studio.connect();
    expect(calls).toEqual([]);
    current = token;
    await studio.connect();
    expect(studio.getSnapshot()).toMatchObject({ composing: true, projectId: "" });
    await studio.generate(1, "");
    expect(calls.some((c) => c.path === "/api/studio/generate")).toBe(false);
  });

  it("creates the compiled project through create_project, then selects it", async () => {
    const created: unknown[] = [];
    const { fetcher } = server({
      "/api/studio/status": () => status,
      "/api/tools/create_project": (body) => {
        created.push(body);
        return { ok: true };
      },
      "/api/tools/list_projects": () => ({
        ok: true,
        projects: (created as { projectId: string }[]).map((c) => ({
          projectId: c.projectId,
          createdAt: "1",
          name: null,
          options: 0,
        })),
      }),
      "/api/tools/project_overview": () => ({ ...overview("done"), options: [] }),
    });
    const studio = new StudioSession(() => token, fetcher);
    const draft = PRESETS[1]?.draft;
    if (!draft) throw new Error("missing preset");
    studio.setDraft(structuredClone(draft));
    await studio.create();
    const compiled = compileProject(draft);
    if (!compiled.ok) throw new Error(compiled.message);
    expect(created).toEqual([
      {
        projectId: expect.stringMatching(
          /^synthetic-asymmetric-bedrooms-with-distinct-acce-[0-9a-f]{8}$/,
        ),
        ref: "main",
        baseRevision: null,
        requestId: expect.any(String),
        body: { model: compiled.value.model, brief: compiled.value.brief },
      },
    ]);
    expect(studio.getSnapshot().projectId).toBe((created[0] as { projectId: string }).projectId);
  });

  it("refuses to post an invalid draft and explains an offline generation", async () => {
    const { fetcher, calls } = server({
      "/api/studio/generate": () => ({ ok: false, code: "agent_unavailable" }),
      "/api/tools/project_overview": () => overview("done"),
    });
    const studio = new StudioSession(() => token, fetcher);
    const draft = structuredClone(PRESETS[0]?.draft);
    if (!draft) throw new Error("missing preset");
    draft.shell.width = 0;
    studio.setDraft(draft);
    await studio.create();
    expect(calls).toEqual([]);
    expect(studio.getSnapshot().message).toMatch(/positive whole millimetres/);
    await studio.select("b");
    await studio.generate(2, " east ");
    expect(calls.find((c) => c.path === "/api/studio/generate")?.body).toEqual({
      projectId: "b",
      count: 2,
      note: "east",
    });
    expect(studio.getSnapshot().message).toMatch(/without --offline/);
  });

  it("reports a missing studio server clearly", async () => {
    const { fetcher } = server({});
    const studio = new StudioSession(() => token, fetcher);
    await studio.connect();
    expect(studio.getSnapshot()).toMatchObject({
      status: null,
      message: expect.stringContaining("pnpm studio"),
    });
  });
});
