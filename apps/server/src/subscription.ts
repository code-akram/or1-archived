import { isDeepStrictEqual } from "node:util";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type AuthInteraction,
  createAssistantMessageEventStream,
  createModels,
  type LoginOptions,
  lazyStream,
  type Model,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/** Project normalized responses, never provider diagnostics, raw errors or transport metadata. */
function safeMessage(message: AssistantMessage, model: Model<Api>): AssistantMessage {
  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: failed
      ? []
      : message.content.map((block) => {
          if (block.type === "text") {
            return {
              type: block.type,
              text: block.text,
              ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}),
            };
          }
          if (block.type === "thinking") {
            return {
              type: block.type,
              thinking: block.thinking,
              ...(block.thinkingSignature !== undefined
                ? { thinkingSignature: block.thinkingSignature }
                : {}),
              ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
            };
          }
          return {
            type: block.type,
            id: block.id,
            name: block.name,
            arguments: structuredClone(block.arguments),
            ...(block.thoughtSignature !== undefined
              ? { thoughtSignature: block.thoughtSignature }
              : {}),
            ...(block.namespace !== undefined ? { namespace: block.namespace } : {}),
          };
        }),
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      totalTokens: message.usage.totalTokens,
      cost: {
        input: message.usage.cost.input,
        output: message.usage.cost.output,
        cacheRead: message.usage.cost.cacheRead,
        cacheWrite: message.usage.cost.cacheWrite,
        total: message.usage.cost.total,
      },
    },
    stopReason: message.stopReason,
    timestamp: message.timestamp,
    ...(failed
      ? {
          errorMessage:
            message.stopReason === "aborted"
              ? "Subscription request cancelled"
              : "Subscription request failed",
        }
      : {}),
  };
}

/** Private, memory-only ChatGPT session. Construction/listing never log in or call a model. */
export function createSubscription() {
  const provider = openaiProvider();
  const oauth = provider.auth.oauth;
  if (!oauth) throw new Error("ChatGPT OAuth is unavailable");
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  // Remove API-key auth at its source, not merely by preferring OAuth over ambient credentials.
  models.setProvider({ ...provider, auth: { oauth } });

  async function available(signal?: AbortSignal) {
    try {
      const options = signal ? { signal } : undefined;
      if ((await models.checkAuth(provider.id, options))?.type !== "oauth")
        throw new Error("missing_oauth");
      return await models.getAvailable(provider.id, options);
    } catch {
      throw new Error(
        signal?.aborted ? "Subscription request cancelled" : "ChatGPT OAuth login required",
      );
    }
  }

  return {
    /** Host owns AuthInteraction and the stable installation UUID via LoginOptions.getDeviceId. */
    async login(interaction: AuthInteraction, options?: LoginOptions): Promise<void> {
      try {
        await models.login(provider.id, "oauth", interaction, options);
      } catch {
        // OAuth failures may contain token response bodies. Do not expose a cause or raw message.
        throw new Error(
          interaction.signal?.aborted ? "ChatGPT login cancelled" : "ChatGPT OAuth login failed",
        );
      }
    },

    async list(): Promise<{ id: string; name: string }[]> {
      return (await available()).map(({ id, name }) => ({ id, name }));
    },

    async select(modelId: string): Promise<{ model: Model<Api>; streamFn: StreamFn }> {
      const selected = (await available()).find((model) => model.id === modelId);
      if (!selected) throw new Error("ChatGPT model unavailable");
      // Neither the returned model nor a StreamFn argument can change the authenticated endpoint.
      const canonical = structuredClone(selected);
      const model = structuredClone(canonical);
      const streamFn: StreamFn = async (requested, context, options) => {
        if (!isDeepStrictEqual(requested, canonical))
          throw new Error("ChatGPT model selection changed");
        const current = (await available(options?.signal)).find((entry) => entry.id === modelId);
        if (!current || !isDeepStrictEqual(current, canonical))
          throw new Error("ChatGPT model unavailable");
        const stream = createAssistantMessageEventStream();
        // Only generation/budget options enter Models. Auth, transport callbacks, arbitrary payload
        // overrides and environment values never cross this boundary. Models owns locked refresh.
        void (async () => {
          try {
            const upstream = models.streamSimple(canonical, context, {
              ...(options?.signal !== undefined ? { signal: options.signal } : {}),
              ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
              ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
              ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
              ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
            });
            for await (const event of upstream) {
              if (event.type === "error") {
                const reason = options?.signal?.aborted ? "aborted" : event.reason;
                stream.push({
                  type: "error",
                  reason,
                  error: safeMessage({ ...event.error, stopReason: reason }, canonical),
                });
              } else if (event.type === "done") {
                stream.push({
                  type: "done",
                  reason: event.reason,
                  message: safeMessage(event.message, canonical),
                });
              } else {
                stream.push({ ...event, partial: safeMessage(event.partial, canonical) });
              }
            }
            stream.end(safeMessage(await upstream.result(), canonical));
          } catch {
            // Use pi's setup-error construction, but with an application-owned message only.
            const message = await lazyStream(canonical, async () => {
              throw new Error("Subscription request failed");
            }).result();
            message.stopReason = options?.signal?.aborted ? "aborted" : "error";
            stream.push({
              type: "error",
              reason: message.stopReason === "aborted" ? "aborted" : "error",
              error: safeMessage(message, canonical),
            });
            stream.end();
          }
        })();
        return stream;
      };
      return { model, streamFn };
    },
  };
}
