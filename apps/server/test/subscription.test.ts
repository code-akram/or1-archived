import { Agent } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AuthInteraction,
  createAssistantMessageEventStream,
  normalizeContext,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  Type,
} from "@earendil-works/pi-ai";
import * as openai from "@earendil-works/pi-ai/providers/openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubscription } from "../src/subscription.ts";

vi.mock("@earendil-works/pi-ai/providers/openai", { spy: true });

// Keep the pinned provider's real catalog/metadata and Models/store/auth machinery. Replace only
// OAuth network operations and inference at the provider boundary; no production injection API.
const builtin = openai.openaiProvider();
const first = builtin.getModels()[0];
if (!first) throw new Error("Pinned OpenAI catalog is empty");
const catalogModel = first;
const secret = "synthetic-access-token-never-persist";
const refreshSecret = "synthetic-refresh-token-never-persist";
const credential = (expires = Date.now() + 3_600_000): OAuthCredential => ({
  type: "oauth",
  access: secret,
  refresh: refreshSecret,
  expires,
  clientId: "synthetic-client",
  scopes: "chatgpt.tokens.use.direct",
});
const interaction = (): AuthInteraction => ({ prompt: vi.fn(async () => ""), notify: vi.fn() });
const transcript = normalizeContext({
  messages: [{ role: "user", content: "Synthetic trial", timestamp: 1 }],
});
const message = (stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant",
  api: catalogModel.api,
  provider: "openai",
  model: catalogModel.id,
  content: [{ type: "text", text: "Synthetic answer", textSignature: "response-item-id" }],
  usage: {
    input: 7,
    output: 13,
    cacheRead: 3,
    cacheWrite: 1,
    totalTokens: 24,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 2,
});

function response(value = message()) {
  const stream = createAssistantMessageEventStream();
  if (value.stopReason === "error" || value.stopReason === "aborted") {
    stream.push({ type: "error", reason: value.stopReason, error: value });
  } else {
    stream.push({ type: "start", partial: value });
    stream.push({
      type: "done",
      reason: value.stopReason === "toolUse" ? "toolUse" : "stop",
      message: value,
    });
  }
  stream.end();
  return stream;
}

function setup(initial = credential()) {
  const oauth: OAuthAuth = {
    name: "Synthetic ChatGPT OAuth",
    isSubscription: true,
    login: vi.fn(async () => initial),
    refresh: vi.fn(async () => credential()),
    toAuth: vi.fn(async (current) => ({ apiKey: current.access })),
  };
  const apiKey = {
    ...builtin.auth.apiKey,
    name: "Forbidden paid API",
    resolve: vi.fn(async () => ({ auth: { apiKey: "ambient-paid-key" } })),
  };
  const provider: Provider<"openai-responses"> = {
    ...builtin,
    auth: { oauth, apiKey },
    filterModels: vi.fn((models: ReturnType<typeof builtin.getModels>) => models),
    streamSimple: vi.fn(() => response()),
  };
  vi.mocked(openai.openaiProvider).mockReturnValue(provider);
  return { session: createSubscription(), oauth, apiKey, provider };
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "ambient-paid-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in subscription tests");
    }),
  );
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("private ChatGPT subscription session", () => {
  it("requires explicit OAuth and never uses ambient or paid API-key auth", async () => {
    const { session, oauth, apiKey, provider } = setup();
    await expect(session.list()).rejects.toThrow("ChatGPT OAuth login required");
    await expect(session.select(catalogModel.id)).rejects.toThrow("ChatGPT OAuth login required");
    expect(oauth.login).not.toHaveBeenCalled();
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(apiKey.resolve).not.toHaveBeenCalled();
    expect(provider.streamSimple).not.toHaveBeenCalled();
    const separate = createSubscription();
    await session.login(interaction());
    await expect(separate.list()).rejects.toThrow("ChatGPT OAuth login required");
  });

  it("passes host interaction and stable device ID seam, exposes no login credential", async () => {
    const { session, oauth } = setup();
    const ui = interaction();
    const id = "83bc38e7-6f7f-468d-8d66-602b177f29f6";
    const options = { getDeviceId: () => id };
    await expect(session.login(ui, options)).resolves.toBeUndefined();
    await session.login(ui, options);
    for (const [forwarded, loginOptions] of vi.mocked(oauth.login).mock.calls) {
      expect(forwarded.prompt).toBe(ui.prompt);
      expect(forwarded.notify).toBe(ui.notify);
      expect(loginOptions).toBe(options);
      expect(loginOptions?.getDeviceId?.()).toBe(id);
    }
    const list = await session.list();
    expect(list).toContainEqual({ id: catalogModel.id, name: catalogModel.name });
    expect(list.every((model) => Object.keys(model).sort().join() === "id,name")).toBe(true);
    expect(JSON.stringify({ session, list })).not.toContain(secret);
    expect(JSON.stringify({ session, list })).not.toContain(refreshSecret);
    expect(oauth.refresh).not.toHaveBeenCalled();
  });

  it("rejects unknown, unavailable and tampered models before dispatch", async () => {
    const { session, provider } = setup();
    await session.login(interaction());
    await expect(session.select(`unknown-${secret}`)).rejects.toThrow("ChatGPT model unavailable");
    const { model, streamFn } = await session.select(catalogModel.id);
    await expect(
      streamFn({ ...model, baseUrl: "https://attacker.invalid" }, transcript),
    ).rejects.toThrow("ChatGPT model selection changed");
    await expect(
      streamFn({ ...model, headers: { Authorization: secret } }, transcript),
    ).rejects.toThrow("ChatGPT model selection changed");
    if (!provider.filterModels) throw new Error("Missing synthetic availability filter");
    vi.mocked(provider.filterModels).mockReturnValue([]);
    await expect(session.select(catalogModel.id)).rejects.toThrow("ChatGPT model unavailable");
    await expect(streamFn(model, transcript)).rejects.toThrow("ChatGPT model unavailable");
    expect(provider.streamSimple).not.toHaveBeenCalled();
  });

  it("preserves runner budgets/cancellation but strips every auth/transport override", async () => {
    const { session, provider, oauth, apiKey } = setup();
    await session.login(interaction());
    const { model, streamFn } = await session.select(catalogModel.id);
    const signal = new AbortController().signal;
    const forbidden = vi.fn();
    const stream = await streamFn(model, transcript, {
      signal,
      timeoutMs: 789,
      maxTokens: 43,
      maxRetries: 0,
      reasoning: "low",
      apiKey: "paid-override",
      env: { OPENAI_API_KEY: "paid-override" },
      headers: { Authorization: "Bearer paid-override" },
      fetch: forbidden,
      onPayload: forbidden,
      onResponse: forbidden,
      onProviderStreamEvent: forbidden,
      samplingParams: { max_output_tokens: 100_000 },
      ...{ transformHeaders: forbidden },
    });
    expect(await stream.result()).toMatchObject({
      content: message().content,
      usage: message().usage,
    });
    const [sentModel, sentContext, sentOptions] =
      vi.mocked(provider.streamSimple).mock.calls[0] ?? [];
    expect(sentModel).toEqual(catalogModel);
    expect(sentContext).toEqual(transcript);
    expect(sentOptions).toEqual({
      signal,
      timeoutMs: 789,
      maxTokens: 43,
      maxRetries: 0,
      reasoning: "low",
      apiKey: secret,
      headers: undefined,
      env: undefined,
    });
    expect(oauth.toAuth).toHaveBeenCalledWith(credential(expect.any(Number)));
    expect(apiKey.resolve).not.toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("uses one Models credential lock for concurrent refresh and reuses the rotated token", async () => {
    const { session, oauth, provider } = setup(credential(0));
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rotated = { ...credential(), access: "rotated-access", refresh: "rotated-refresh" };
    vi.mocked(oauth.refresh).mockImplementation(async () => {
      await barrier;
      return rotated;
    });
    await session.login(interaction());
    const { model, streamFn } = await session.select(catalogModel.id);
    expect(oauth.refresh).not.toHaveBeenCalled(); // listing/selection must not spend network quota
    const streams = await Promise.all([streamFn(model, transcript), streamFn(model, transcript)]);
    await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1));
    expect(provider.streamSimple).not.toHaveBeenCalled();
    release();
    await Promise.all(streams.map((stream) => stream.result()));
    await (await streamFn(model, transcript)).result();
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(oauth.refresh).toHaveBeenCalledWith(credential(0), expect.any(AbortSignal));
    expect(vi.mocked(provider.streamSimple).mock.calls.map((call) => call[2]?.apiKey)).toEqual([
      "rotated-access",
      "rotated-access",
      "rotated-access",
    ]);
  });

  it("rejects pre-aborted calls and cancels refresh without dispatch or raw abort reason", async () => {
    const { session, oauth, provider } = setup(credential(0));
    await session.login(interaction());
    const { model, streamFn } = await session.select(catalogModel.id);
    const cancellation = new AbortController();
    cancellation.abort(new Error(secret));
    await expect(streamFn(model, transcript, { signal: cancellation.signal })).rejects.toThrow(
      "Subscription request cancelled",
    );
    expect(oauth.refresh).not.toHaveBeenCalled();
    const active = new AbortController();
    vi.mocked(oauth.refresh).mockImplementation(
      async (_credential, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const stream = await streamFn(model, transcript, { signal: active.signal });
    await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1));
    active.abort(new Error(secret));
    expect(await stream.result()).toMatchObject({
      stopReason: "aborted",
      errorMessage: "Subscription request cancelled",
      content: [],
    });
    expect(JSON.stringify(await stream.result())).not.toContain(secret);
    expect(provider.streamSimple).not.toHaveBeenCalled();
  });

  it("propagates active inference cancellation and hides the provider's abort payload", async () => {
    const { session, provider } = setup();
    await session.login(interaction());
    const cancellation = new AbortController();
    vi.mocked(provider.streamSimple).mockImplementation((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        () => {
          const error = { ...message("aborted"), errorMessage: secret };
          stream.push({ type: "error", reason: "aborted", error });
          stream.end();
        },
        { once: true },
      );
      return stream;
    });
    const { model, streamFn } = await session.select(catalogModel.id);
    const stream = await streamFn(model, transcript, { signal: cancellation.signal });
    await vi.waitFor(() => expect(provider.streamSimple).toHaveBeenCalledTimes(1));
    cancellation.abort(new Error(refreshSecret));
    expect(await stream.result()).toMatchObject({
      stopReason: "aborted",
      errorMessage: "Subscription request cancelled",
      content: [],
    });
    expect(JSON.stringify(await stream.result())).not.toContain(secret);
    expect(JSON.stringify(await stream.result())).not.toContain(refreshSecret);
  });

  it.each(["refresh", "toAuth", "stream"])(
    "sanitizes raw %s failures without paid fallback or token disclosure",
    async (stage) => {
      const { session, oauth, provider, apiKey } = setup(
        credential(stage === "refresh" ? 0 : undefined),
      );
      const fail = () => {
        throw new Error(`Authorization: Bearer ${secret}; refresh=${refreshSecret}`);
      };
      if (stage === "stream") vi.mocked(provider.streamSimple).mockImplementation(fail);
      else vi.mocked(oauth[stage === "refresh" ? "refresh" : "toAuth"]).mockImplementation(fail);
      await session.login(interaction());
      const { model, streamFn } = await session.select(catalogModel.id);
      const stream = await streamFn(model, transcript);
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) events.push(event);
      expect(await stream.result()).toMatchObject({
        stopReason: "error",
        errorMessage: "Subscription request failed",
        content: [],
      });
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(refreshSecret);
      expect(apiKey.resolve).not.toHaveBeenCalled();
      if (stage !== "stream") expect(provider.streamSimple).not.toHaveBeenCalled();
    },
  );

  it("does not expose raw login failures, causes, cancelled reasons or credentials", async () => {
    const { session, oauth } = setup();
    vi.mocked(oauth.login).mockRejectedValue(new Error(secret, { cause: refreshSecret }));
    const error = await session.login(interaction()).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: ChatGPT OAuth login failed");
    expect(error).not.toHaveProperty("cause");
    const ui = interaction();
    ui.signal = AbortSignal.abort(new Error(secret));
    await expect(session.login(ui)).rejects.toThrow("ChatGPT login cancelled");
    expect(oauth.login).toHaveBeenCalledTimes(1);
    await expect(session.list()).rejects.toThrow("ChatGPT OAuth login required");
  });

  it("removes raw error content and diagnostics from normalized persisted-message candidates", async () => {
    const { session, provider } = setup();
    await session.login(interaction());
    const { model, streamFn } = await session.select(catalogModel.id);
    const unsafe = {
      ...message("error"),
      content: [{ type: "text" as const, text: refreshSecret }],
      errorMessage: secret,
      rawStopReason: refreshSecret,
      diagnostics: [{ type: "transport", timestamp: 1, error: { message: secret } }],
      headers: { Authorization: secret },
    };
    vi.mocked(provider.streamSimple).mockImplementation(() => response(unsafe));
    const result = await (await streamFn(model, transcript)).result();
    expect(result.content).toEqual([]);
    expect(result.usage.totalTokens).toBe(24); // failure usage still reaches runner accounting
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(refreshSecret);
    vi.mocked(provider.streamSimple).mockImplementation(() =>
      response({ ...unsafe, ...message(), diagnostics: unsafe.diagnostics }),
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of await streamFn(model, transcript)) events.push(event);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(refreshSecret);
  });

  it("works with the pinned Agent and preserves tool/thinking replay signatures and usage", async () => {
    const { session, provider } = setup();
    await session.login(interaction());
    const toolMessage: AssistantMessage = {
      ...message("toolUse"),
      content: [
        {
          type: "thinking",
          thinking: "Synthetic reasoning",
          thinkingSignature: "opaque-replay",
          redacted: true,
        },
        {
          type: "toolCall",
          id: "call-1",
          name: "synthetic",
          arguments: { value: 7 },
          thoughtSignature: "tool-replay",
        },
      ],
    };
    vi.mocked(provider.streamSimple).mockImplementationOnce(() => response(toolMessage));
    const selected = await session.select(catalogModel.id);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "8" }],
      details: { value: 8 },
    }));
    const agent = new Agent({
      initialState: {
        model: selected.model,
        tools: [
          {
            name: "synthetic",
            label: "Synthetic",
            description: "Synthetic only",
            parameters: Type.Object({ value: Type.Number() }),
            execute,
          },
        ],
      },
      streamFn: selected.streamFn,
    });
    await agent.prompt("Synthetic trial");
    expect(agent.state.errorMessage).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { value: 7 },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(agent.state.messages).toContainEqual(expect.objectContaining(toolMessage));
    expect(agent.state.messages.at(-1)).toMatchObject(message());
    expect(vi.mocked(provider.streamSimple).mock.calls[1]?.[1].messages).toContainEqual(
      expect.objectContaining(toolMessage),
    );
  });
});
