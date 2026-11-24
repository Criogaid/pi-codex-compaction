// Own summary-model resolution and Pi's native text summarization through the model registry.
import { getSupportedThinkingLevels, type Api, type AssistantMessage, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { compact, SettingsManager, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SummaryModel } from "./fallback-settings.js";

const REQUEST_TIMEOUT_MS = 300_000;

interface FallbackModel {
  readonly model: Model<Api>;
  readonly thinkingLevel: ModelThinkingLevel;
}

export interface FallbackCompactionRequest {
  readonly summaryModel: SummaryModel | undefined;
  /** Used only when layered recovery must own the native chat-model fallback. */
  readonly defaultModel?: FallbackModel;
  readonly modelRegistry: ModelRegistry;
  readonly preparation: Parameters<typeof compact>[0];
  readonly settings: ReturnType<ExtensionAPI["getSettings"]>;
  readonly customInstructions?: string;
  readonly signal: AbortSignal;
  readonly sessionId: string;
  /** Check session ownership before preparation and each provider attempt. */
  readonly onPrepared: (selection: FallbackModel) => void;
}

function selectFallback(summary: SummaryModel | undefined, registry: ModelRegistry): FallbackModel | undefined {
  if (!summary) return undefined;
  const model = registry.find(summary.provider, summary.model);
  if (!model) throw new Error(`summaryModel.model must name a configured model: ${summary.provider}/${summary.model}`);
  const supportedLevels = getSupportedThinkingLevels(model);
  const thinkingLevel = supportedLevels.find((level) => level === summary.thinkingLevel);
  if (thinkingLevel === undefined) {
    throw new Error(`summaryModel.thinkingLevel must be supported by ${model.provider}/${model.id}: ${supportedLevels.join(", ")}`);
  }
  return { model, thinkingLevel };
}

/** Return undefined without a configured or default model. Failures must stop native compaction. */
export async function requestFallbackCompaction(request: FallbackCompactionRequest) {
  request.signal.throwIfAborted();
  const selection = selectFallback(request.summaryModel, request.modelRegistry) ?? request.defaultModel;
  request.signal.throwIfAborted();
  if (!selection) return undefined;
  request.onPrepared(selection);
  const settings = SettingsManager.inMemory(request.settings);
  const providerRetry = settings.getProviderRetrySettings();
  // pi-virtual limits are display hints. Zero lets native compact use its reserve budget;
  // streamSimple routes the original model and caps each request to the physical model's limit.
  const budgetModel = selection.model.api === "pi-virtual" ? { ...selection.model, maxTokens: 0 } : selection.model;
  // Pi can append file lists to empty summaries; inspect the actual completions.
  const responses: AssistantMessage[] = [];
  const result = await compact(
    request.preparation,
    budgetModel,
    undefined,
    undefined,
    request.customInstructions,
    request.signal,
    selection.thinkingLevel,
    async (_model, context, options) => {
      request.signal.throwIfAborted();
      const stream = request.modelRegistry.streamSimple(selection.model, context, {
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
      const message = await stream.result();
      // Pi treats an aborted response as terminal for retries but can still start the next segment.
      if (message.stopReason === "aborted") {
        request.signal.throwIfAborted();
        throw new Error("Fallback compaction was aborted by the provider");
      }
      responses.push(message);
      return stream;
    },
    undefined,
    settings.getRetrySettings(),
    undefined,
    request.sessionId,
  );
  request.signal.throwIfAborted();
  request.onPrepared(selection);
  for (const message of responses) {
    // Pi owns retrying error responses; validate only completions it accepted.
    if (message.stopReason !== "error" && !message.content.some((block) => block.type === "text" && block.text.trim())) {
      throw new Error("Fallback compaction returned an empty summary");
    }
  }
  return { compaction: result };
}
