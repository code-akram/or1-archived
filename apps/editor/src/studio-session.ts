import type {
  GenerateResult,
  ProjectListing,
  ProjectOverview,
  ProjectOverviewResult,
  StudioStatus,
} from "@or1/tools";
import { compileProject, PRESETS, type ProjectDraft } from "./draft.ts";

export type StudioState = {
  /** null until connected; agent is null when the studio runs offline. */
  status: StudioStatus | null;
  projects: ProjectListing["projects"];
  projectId: string;
  overview: ProjectOverview | undefined;
  busy: "" | "connecting" | "creating" | "generating";
  message: string;
  draft: ProjectDraft;
  composing: boolean;
};

/** A run that may still change its option's head. */
export const isLive = (status: string) => status === "queued" || status === "running";

/**
 * Memory-only owner studio controller. The token is read from the review session on every call,
 * so there is one credential in page memory and clearing it stops polling.
 */
export class StudioSession {
  private state: StudioState = {
    status: null,
    projects: [],
    projectId: "",
    overview: undefined,
    busy: "",
    message: "",
    draft: structuredClone(PRESETS[0]?.draft) as ProjectDraft,
    composing: false,
  };
  private listeners = new Set<() => void>();
  private fetcher: typeof fetch;
  private token: () => string;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  readonly pollMs: number;

  constructor(
    token: () => string,
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    pollMs = 1500,
  ) {
    this.token = token;
    this.fetcher = fetcher;
    this.pollMs = pollMs;
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(change: Partial<StudioState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Loads studio status and the project list; selects the newest project if none is chosen. */
  async connect() {
    if (!this.token()) return;
    const generation = ++this.generation;
    this.update({ busy: "connecting", message: "" });
    try {
      const status = await this.post<StudioStatus>("/api/studio/status", {});
      const listing = await this.post<ProjectListing>("/api/tools/list_projects", {});
      if (generation !== this.generation) return;
      const projects = listing.ok ? listing.projects : [];
      const keep = projects.some((p) => p.projectId === this.state.projectId);
      const projectId = keep ? this.state.projectId : (projects.at(-1)?.projectId ?? "");
      this.update({
        status: status.ok ? status : null,
        projects,
        projectId,
        composing: !projects.length,
        busy: "",
      });
      if (projectId) await this.refresh();
    } catch (error) {
      if (generation === this.generation)
        this.update({ busy: "", status: null, message: messageOf(error, "Studio unavailable.") });
    }
  }

  disconnect() {
    this.generation++;
    this.stopPolling();
    this.update({ status: null, projects: [], overview: undefined, busy: "", message: "" });
  }

  async select(projectId: string) {
    this.stopPolling();
    this.update({ projectId, overview: undefined, composing: false, message: "" });
    await this.refresh();
  }

  compose(open: boolean) {
    this.update({ composing: open, message: "" });
  }

  setDraft(draft: ProjectDraft) {
    this.update({ draft });
  }

  /** Fetches the selected project's overview and keeps polling while any agent run is live. */
  async refresh() {
    this.stopPolling();
    const projectId = this.state.projectId;
    if (!projectId || !this.token()) return;
    const generation = this.generation;
    try {
      const overview = await this.post<ProjectOverviewResult>("/api/tools/project_overview", {
        projectId,
      });
      if (generation !== this.generation || projectId !== this.state.projectId) return;
      if (!overview.ok) {
        this.update({ overview: undefined, message: `${overview.code}` });
        return;
      }
      // Keep the picker's option count derived from the latest overview, not a stale listing.
      this.update({
        overview,
        projects: this.state.projects.map((project) =>
          project.projectId === projectId
            ? { ...project, options: overview.options.length }
            : project,
        ),
      });
      if (overview.options.some((option) => option.runs.some((run) => isLive(run.status))))
        this.poll = setTimeout(() => void this.refresh(), this.pollMs);
    } catch (error) {
      if (generation === this.generation)
        this.update({ message: messageOf(error, "Overview unavailable.") });
    }
  }

  async create() {
    const compiled = compileProject(this.state.draft);
    if (!compiled.ok) {
      this.update({ message: compiled.message });
      return;
    }
    this.update({ busy: "creating", message: "" });
    try {
      const slug =
        (compiled.value.brief.name ?? "project")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 48) || "project";
      const projectId = `${slug}-${crypto.randomUUID().slice(0, 8)}`;
      const created = await this.post<{ ok: boolean; code?: string; message?: string }>(
        "/api/tools/create_project",
        {
          projectId,
          ref: "main",
          baseRevision: null,
          requestId: crypto.randomUUID(),
          body: { model: compiled.value.model, brief: compiled.value.brief },
        },
      );
      if (!created.ok) {
        this.update({
          busy: "",
          message: `${created.code}${created.message ? `: ${created.message}` : ""}`,
        });
        return;
      }
      this.update({ busy: "", projectId, composing: false });
      await this.connect();
    } catch (error) {
      this.update({ busy: "", message: messageOf(error, "Project creation failed.") });
    }
  }

  async generate(count: number, note: string) {
    const projectId = this.state.projectId;
    if (!projectId || this.state.busy) return;
    this.update({ busy: "generating", message: "" });
    try {
      const result = await this.post<GenerateResult>("/api/studio/generate", {
        projectId,
        count,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      this.update({
        busy: "",
        message: result.ok
          ? ""
          : result.code === "agent_unavailable"
            ? "No agent is signed in. Restart the studio without --offline to generate options."
            : result.code,
      });
      await this.refresh();
    } catch (error) {
      this.update({ busy: "", message: messageOf(error, "Generation failed.") });
    }
  }

  async cancel(runId: string) {
    try {
      await this.post("/api/studio/cancel", { runId });
    } finally {
      await this.refresh();
    }
  }

  stopPolling() {
    if (this.poll !== undefined) clearTimeout(this.poll);
    this.poll = undefined;
  }

  private async post<T extends { ok: boolean }>(path: string, body: unknown): Promise<T> {
    const token = this.token();
    if (!token) throw new Error("Enter the local owner token.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetcher(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 401) throw new Error("The owner token was rejected.");
      if (response.status === 404)
        throw new Error("Studio routes unavailable. Start it with `pnpm studio`.");
      if (response.status >= 500) throw new Error(`Server unavailable (${response.status}).`);
      const result = (await response.json()) as T;
      if (!result || typeof result.ok !== "boolean")
        throw new Error(`Unexpected server response (${response.status}).`);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
