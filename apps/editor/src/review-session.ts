import type {
  AcceptOptionInput,
  AcceptOptionResult,
  CloudSession,
  ReviewOptionInput,
  ReviewOptionResult,
  ReviewOptionSuccess,
} from "@or1/tools";

export type Inputs = { projectId: string; ref: string; token: string };
type Intent = { input: AcceptOptionInput; credentialFingerprint: string };
type Acceptance =
  | { status: "sending"; intent: Intent }
  | { status: "uncertain"; intent: Intent }
  | { status: "resolved"; intent: Intent; result: AcceptOptionResult };
export type ReviewState = {
  mode: "loading" | "local" | "cloud" | "blocked";
  cloudSession: CloudSession | undefined;
  /** Presentation only: retained after demo expiry/failure, never used for authorization. */
  developmentDemoExpiresAt: number | undefined;
  refreshing: boolean;
  inputs: Inputs;
  reviewing: boolean;
  accepting: boolean;
  review: ReviewOptionSuccess | undefined;
  acceptance: Acceptance | undefined;
  message: string;
};

/** Memory-only session. Review responses are disposable; mutation intents are not. */
export class ReviewSession {
  private state: ReviewState = {
    mode: "loading",
    cloudSession: undefined,
    developmentDemoExpiresAt: undefined,
    refreshing: false,
    inputs: { projectId: "", ref: "", token: "" },
    reviewing: false,
    accepting: false,
    review: undefined,
    acceptance: undefined,
    message: "",
  };
  private generation = 0;
  private listeners = new Set<() => void>();
  private fetcher: typeof fetch;
  private hostname: string;
  private cloudDetected = false;

  constructor(
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    hostname = globalThis.location?.hostname ?? "localhost",
  ) {
    this.fetcher = fetcher;
    this.hostname = hostname;
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(change: Partial<ReviewState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  async refreshSession() {
    if (this.state.refreshing || this.state.mode === "local") return;
    this.generation++;
    this.update({
      mode: "loading",
      refreshing: true,
      review: undefined,
      reviewing: false,
      message: "",
      inputs: { ...this.state.inputs, token: "" },
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetcher("/api/session", {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (
        response.status === 404 &&
        !response.redirected &&
        !this.cloudDetected &&
        ["localhost", "127.0.0.1", "[::1]", "::1"].includes(this.hostname)
      ) {
        this.update({ mode: "local", cloudSession: undefined });
        return;
      }
      if (!response.ok || response.redirected) throw new Error("Session unavailable.");
      const session: unknown = await response.json();
      if (!isCloudSession(session)) throw new Error("Session malformed.");
      this.cloudDetected = true;
      this.update({
        developmentDemoExpiresAt:
          session.authentication === "development-bypass" ? session.expiresAt : undefined,
      });
      if (session.expiresAt <= Date.now()) throw new Error("Session expired.");
      const previous = this.state.cloudSession;
      const samePrincipal = previous?.principalId === session.principalId;
      const project =
        (samePrincipal &&
          session.projects.find((project) => project.projectId === this.state.inputs.projectId)) ||
        session.projects[0];
      this.update({
        mode: "cloud",
        cloudSession: session,
        inputs: {
          projectId: project?.projectId ?? "",
          ref:
            samePrincipal && project?.projectId === this.state.inputs.projectId
              ? this.state.inputs.ref
              : (project?.refs.find((ref) => ref !== "main") ?? project?.refs[0] ?? ""),
          token: "",
        },
      });
    } catch {
      this.update({
        mode: "blocked",
        cloudSession: undefined,
        inputs: { projectId: "", ref: "", token: "" },
        message:
          this.state.developmentDemoExpiresAt !== undefined
            ? "Public development demo unavailable or expired. Refresh the session to check whether the demo is enabled. No Access login is used for this demo."
            : this.state.cloudSession
              ? "Access session unavailable or expired. Use Cloudflare Access login, then refresh the session. If login has expired, reload this page to sign in."
              : "Session unavailable, malformed or expired. Refresh the session or reload this page to check availability.",
      });
    } finally {
      clearTimeout(timeout);
      this.update({ refreshing: false });
    }
  }

  expireSession() {
    if (this.state.mode !== "cloud" || !this.state.cloudSession) return;
    if (this.state.cloudSession.expiresAt > Date.now()) return;
    this.generation++;
    this.update({
      mode: "blocked",
      cloudSession: undefined,
      review: undefined,
      reviewing: false,
      message:
        this.state.cloudSession.authentication === "development-bypass"
          ? "Public development demo expired. Review is disabled. Refresh the session to check whether the demo is enabled."
          : "Access session expired. Refresh the session or reload this page to sign in.",
    });
  }

  setInputs(inputs: Inputs) {
    if (this.state.mode !== "local") {
      if (this.state.mode !== "cloud") return;
      const project = this.state.cloudSession?.projects.find(
        (project) => project.projectId === inputs.projectId,
      );
      if (!project) return;
      inputs = {
        ...inputs,
        token: "",
        ref:
          inputs.projectId !== this.state.inputs.projectId
            ? (project.refs.find((ref) => ref !== "main") ?? project.refs[0] ?? "")
            : inputs.ref,
      };
    }
    this.generation++;
    this.update({ inputs, review: undefined, reviewing: false, message: "" });
  }

  async review() {
    this.expireSession();
    const { mode, cloudSession } = this.state;
    if (mode !== "local" && mode !== "cloud") return;
    if (this.state.accepting || this.unresolved()) return;
    const { projectId, ref, token } = this.state.inputs;
    if (!projectId || !ref || (mode === "local" && !token)) return;
    if (mode === "cloud" && !cloudSession?.projects.some((p) => p.projectId === projectId)) return;
    const generation = ++this.generation;
    this.update({ reviewing: true, review: undefined, message: "" });
    try {
      const input: ReviewOptionInput = { projectId, ref };
      const result = await this.post<ReviewOptionResult>(
        "review_option",
        input,
        token,
        cloudSession,
      );
      this.expireSession();
      if (generation !== this.generation) return;
      if (result.ok && (result.projectId !== projectId || result.ref !== ref))
        throw new Error("The server returned a different project or ref. Review again.");
      this.update({
        reviewing: false,
        review: result.ok ? result : undefined,
        message: result.ok ? "" : rejectionMessage(result),
      });
    } catch (error) {
      this.expireSession();
      if (generation !== this.generation) return;
      if (mode === "cloud" && errorMessage(error) === "Access login required.") {
        this.generation++;
        this.update({
          mode: "blocked",
          cloudSession: undefined,
          reviewing: false,
          message:
            cloudSession?.authentication === "development-bypass"
              ? "Public development demo unavailable. Refresh the session to check whether the demo is enabled."
              : "Access login required. Reload this page to sign in, then refresh the session.",
        });
      } else {
        this.update({
          reviewing: false,
          message:
            mode === "cloud" && !(error instanceof Error)
              ? "Review request failed. Refresh the session and try again."
              : errorMessage(error),
        });
      }
    }
  }

  unresolved() {
    return (
      this.state.acceptance?.status === "sending" || this.state.acceptance?.status === "uncertain"
    );
  }

  async accept() {
    if (this.state.mode !== "local") return;
    const { review, inputs } = this.state;
    if (this.state.accepting || this.unresolved() || !review?.eligibility.allowed || !inputs.token)
      return;
    this.update({ accepting: true });
    try {
      const fingerprint = await credentialFingerprint(inputs.token);
      // A credential/input edit during hashing invalidates this review too.
      if (this.state.review !== review || this.state.inputs !== inputs) return;
      const input: AcceptOptionInput = Object.freeze({
        projectId: review.projectId,
        ref: "main",
        baseRevision: review.main.revisionId,
        requestId: crypto.randomUUID(),
        body: Object.freeze({
          sourceRef: review.ref,
          sourceRevisionId: review.option.revisionId,
          briefVersion: review.briefVersion,
          baselineRevisionId: review.baselineRevisionId,
          evaluatorVersion: review.option.scorecard.evaluatorVersion,
        }),
      });
      await this.sendAcceptance({ input, credentialFingerprint: fingerprint }, inputs.token);
    } catch (error) {
      this.update({ message: errorMessage(error) });
    } finally {
      this.update({ accepting: false });
    }
  }

  async retry() {
    if (this.state.mode !== "local") return;
    const acceptance = this.state.acceptance;
    const token = this.state.inputs.token;
    if (this.state.accepting || acceptance?.status !== "uncertain" || !token) return;
    this.update({ accepting: true });
    try {
      if ((await credentialFingerprint(token)) !== acceptance.intent.credentialFingerprint) {
        this.update({ message: "Retry requires the same owner token used for this request." });
        return;
      }
      if (this.state.inputs.token !== token) return;
      await this.sendAcceptance(acceptance.intent, token);
    } catch (error) {
      this.update({ message: errorMessage(error) });
    } finally {
      this.update({ accepting: false });
    }
  }

  private async sendAcceptance(intent: Intent, token: string) {
    const retrying = this.state.acceptance?.status === "uncertain";
    this.generation++;
    this.update({
      reviewing: false,
      review: undefined,
      message: "",
      acceptance: { status: "sending", intent },
    });
    try {
      const result = await this.post<AcceptOptionResult>("accept_option", intent.input, token);
      // Authorization/validation failures and identity conflicts do not establish the original outcome.
      if (
        retrying &&
        !result.ok &&
        [
          "unauthorized",
          "forbidden",
          "store_unavailable",
          "invalid_input",
          "request_conflict",
        ].includes(result.code)
      )
        throw new Error("The server could not resolve the original request.");
      this.update({
        acceptance: { status: "resolved", intent, result },
        message: result.ok
          ? ""
          : `${rejectionMessage(result)}. Review again before a new acceptance.`,
      });
    } catch {
      this.update({
        acceptance: { status: "uncertain", intent },
        message:
          "Response lost or unavailable. Acceptance may have committed. Retry this exact request to resolve it; do not start another acceptance or close this page.",
      });
    }
  }

  private async post<T extends { ok: boolean }>(
    name: string,
    input: unknown,
    token: string,
    session?: CloudSession,
  ): Promise<T> {
    const principalId = session?.principalId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetcher(`/api/tools/${name}`, {
        method: "POST",
        headers: principalId
          ? { "Content-Type": "application/json" }
          : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        credentials: principalId ? "same-origin" : "omit",
        ...(principalId ? { redirect: "error" as const } : {}),
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (principalId && (response.status === 401 || response.redirected))
        throw new Error("Access login required.");
      if (principalId && response.headers.get("X-Or1-Principal-Id") !== principalId)
        throw new Error(
          session?.authentication === "development-bypass"
            ? "Demo identity changed or did not match the session. Refresh the session."
            : "Access identity changed or was not verified. Refresh the session.",
        );
      if (response.status >= 500) throw new Error(`Server unavailable (${response.status}).`);
      const result = (await response.json()) as T;
      if (!result || typeof result.ok !== "boolean" || (!response.ok && result.ok))
        throw new Error(`Unexpected server response (${response.status}).`);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isCloudSession(value: unknown): value is CloudSession {
  if (!value || typeof value !== "object") return false;
  const session = value as CloudSession;
  return (
    session.mode === "cloud" &&
    (session.authentication === undefined || session.authentication === "development-bypass") &&
    typeof session.principalId === "string" &&
    session.principalId.length > 0 &&
    typeof session.expiresAt === "number" &&
    Number.isFinite(session.expiresAt) &&
    Number.isFinite(new Date(session.expiresAt).getTime()) &&
    Array.isArray(session.projects) &&
    session.projects.every(
      (project) =>
        project &&
        typeof project.projectId === "string" &&
        project.projectId.length > 0 &&
        typeof project.label === "string" &&
        (project.membership === "owner" || project.membership === "viewer") &&
        Array.isArray(project.refs) &&
        project.refs.every((ref: unknown) => typeof ref === "string" && ref.length > 0) &&
        project.permissions?.canReview === true &&
        project.permissions.canAccept === false,
    )
  );
}

async function credentialFingerprint(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Request failed. Check the local server and token.";
}

function rejectionMessage(result: { code: string; message?: string }) {
  return `${result.code}${result.message ? `: ${result.message}` : ""}`;
}
