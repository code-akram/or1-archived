import type {
  AcceptOptionInput,
  AcceptOptionResult,
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

  constructor(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.fetcher = fetcher;
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

  setInputs(inputs: Inputs) {
    this.generation++;
    this.update({ inputs, review: undefined, reviewing: false, message: "" });
  }

  async review() {
    if (this.state.accepting || this.unresolved()) return;
    const { projectId, ref, token } = this.state.inputs;
    if (!projectId || !ref || !token) return;
    const generation = ++this.generation;
    this.update({ reviewing: true, review: undefined, message: "" });
    try {
      const input: ReviewOptionInput = { projectId, ref };
      const result = await this.post<ReviewOptionResult>("review_option", input, token);
      if (generation !== this.generation) return;
      if (result.ok && (result.projectId !== projectId || result.ref !== ref))
        throw new Error("The server returned a different project or ref. Review again.");
      this.update({
        reviewing: false,
        review: result.ok ? result : undefined,
        message: result.ok ? "" : rejectionMessage(result),
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.update({ reviewing: false, message: errorMessage(error) });
    }
  }

  unresolved() {
    return (
      this.state.acceptance?.status === "sending" || this.state.acceptance?.status === "uncertain"
    );
  }

  async accept() {
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
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetcher(`/api/tools/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(input),
        signal: controller.signal,
      });
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
