// Own configured fallback selection and Pi's native text summarization through the model registry.
import { open } from "node:fs/promises";
import { getSupportedThinkingLevels, type Api, type AssistantMessage, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { compact, SettingsManager, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { isObject } from "./protocol.js";

export const FALLBACK_SETTINGS_RELATIVE_PATH = "extensions/pi-codex-compaction/config.json";
const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 16 * 1024;
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

async function readSettings(path: string): Promise<unknown> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Could not open fallback settings at ${path}`, { cause: error });
  }
  try {
    const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SETTINGS_BYTES) throw new Error(`Fallback settings must not exceed ${MAX_SETTINGS_BYTES} bytes`);
    // TextDecoder accepts a UTF-8 BOM and rejects invalid bytes without echoing file contents.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not read fallback settings at ${path}; use a UTF-8 JSON object within ${MAX_SETTINGS_BYTES} bytes`, { cause: error });
  } finally {
    await file.close();
  }
}

function selectFallback(settings: unknown, registry: ModelRegistry): FallbackModel | undefined {
  if (settings === undefined) return undefined;
  if (!isObject(settings) || Object.keys(settings).some((key) => !["version", "fallback"].includes(key))) {
    throw new Error("Fallback settings must be an object with version and the optional fallback field");
  }
  if (!("fallback" in settings)) return undefined;
  if (settings.version !== SETTINGS_VERSION) throw new Error(`version must be ${SETTINGS_VERSION} when fallback is configured`);
  const fallback = settings.fallback;
  if (!isObject(fallback) || Object.keys(fallback).some((key) => !["provider", "model", "thinkingLevel"].includes(key))) {
    throw new Error("fallback must be an object with provider, model, and thinkingLevel fields");
  }
  if (typeof fallback.provider !== "string" || !fallback.provider.trim() || fallback.provider !== fallback.provider.trim()) {
    throw new Error("fallback.provider must be a non-empty provider ID without surrounding whitespace");
  }
  if (typeof fallback.model !== "string" || !fallback.model.trim() || fallback.model !== fallback.model.trim()) {
    throw new Error("fallback.model must be a non-empty model ID without surrounding whitespace");
  }
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
  const selection = selectFallback(await readSettings(request.settingsPath), request.modelRegistry);
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
