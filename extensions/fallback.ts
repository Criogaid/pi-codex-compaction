// Own configured fallback selection and Pi's native text summarization through the model registry.
import { getSupportedThinkingLevels, type Api, type AssistantMessage, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { compact, SettingsManager, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { loadFallbackSettings, type FallbackConfiguration } from "./fallback-settings.js";

const REQUEST_TIMEOUT_MS = 300_000;

interface FallbackModel {
  readonly model: Model<Api>;
  readonly thinkingLevel: ModelThinkingLevel;
}

export interface FallbackCompactionRequest {
  readonly settingsPath: string;
  readonly modelRegistry: ModelRegistry;
  readonly preparation: Parameters<typeof compact>[0];
  readonly settings: ReturnType<ExtensionAPI["getSettings"]>;
  readonly customInstructions?: string;
  readonly signal: AbortSignal;
  readonly sessionId: string;
  /** Check session ownership before preparation and each provider attempt. */
  readonly onPrepared: (selection: FallbackModel) => void;
}

function selectFallback(fallback: FallbackConfiguration | undefined, registry: ModelRegistry): FallbackModel | undefined {
  if (!fallback) return undefined;
  const model = registry.find(fallback.provider, fallback.model);
  if (!model) throw new Error(`fallback.model must name a configured model: ${fallback.provider}/${fallback.model}`);
  const supportedLevels = getSupportedThinkingLevels(model);
  const thinkingLevel = supportedLevels.find((level) => level === fallback.thinkingLevel);
  if (thinkingLevel === undefined) {
    throw new Error(`fallback.thinkingLevel must be supported by ${model.provider}/${model.id}: ${supportedLevels.join(", ")}`);
  }
  return { model, thinkingLevel };
}

/** Return undefined only when fallback is disabled. Failures must stop native compaction on the chat model. */
export async function requestFallbackCompaction(request: FallbackCompactionRequest) {
  request.signal.throwIfAborted();
  const selection = selectFallback((await loadFallbackSettings(request.settingsPath)).fallback, request.modelRegistry);
  request.signal.throwIfAborted();
  if (!selection) return undefined;
  request.onPrepared(selection);
  const settings = SettingsManager.inMemory(request.settings);
  const providerRetry = settings.getProviderRetrySettings();
  // Pi 0.99.1 can append file lists to empty or provider-aborted summaries; inspect the actual completions.
  const responses: Promise<AssistantMessage>[] = [];
  const result = await compact(
    request.preparation,
    selection.model,
    undefined,
    undefined,
    request.customInstructions,
    request.signal,
    selection.thinkingLevel,
    (model, context, options) => {
      const stream = request.modelRegistry.streamSimple(model, context, {
        ...options,
        transport: settings.getTransport(),
        thinkingBudgets: settings.getThinkingBudgets(),
        websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(),
        timeoutMs: providerRetry.timeoutMs ?? REQUEST_TIMEOUT_MS,
        maxRetries: providerRetry.maxRetries,
        maxRetryDelayMs: providerRetry.maxRetryDelayMs,
        onPayload: (payload) => {
          request.onPrepared(selection);
          return payload;
        },
      });
      responses.push(stream.result());
      return stream;
    },
    undefined,
    settings.getRetrySettings(),
    undefined,
    request.sessionId,
  );
  request.signal.throwIfAborted();
  request.onPrepared(selection);
  for (const response of responses) {
    const message = await response;
    if (message.stopReason === "aborted") throw new Error("Fallback compaction was aborted by the provider");
    // Pi owns retrying error responses; validate only completions it accepted.
    if (message.stopReason !== "error" && !message.content.some((block) => block.type === "text" && block.text.trim())) {
      throw new Error("Fallback compaction returned an empty summary");
    }
  }
  return { compaction: result };
}
