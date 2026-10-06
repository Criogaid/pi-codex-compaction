// Own V2 request adaptation; Pi's model registry owns authentication and provider dispatch.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, ProviderHeaders, ThinkingBudgets, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { capableModel, deriveEndpoint, normalizeUrl, sameBackend, sameModel, type ProviderIdentity } from "./capability.js";
import { trimToolOutputsToContextWindow } from "./context-window.js";
import { estimateImages, type ImageEstimates } from "./image-budget.js";
import { contextUserItems, type UserItemOrigin } from "./retention-input.js";
import { CodexCompactionProtocolError, createCompactionCollector, isObject, type JsonObject, prepareRemoteCompactionPayload, withoutInputImages } from "./protocol.js";
import { applyProviderRequest, type ProviderRequestSnapshot } from "./request-snapshot.js";
import { CompactionAttempt, compactionRetryLimit, waitForCompactionRetry } from "./remote-retry.js";

const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const REQUEST_TIMEOUT_MS = 300_000;
const MISSING_PAYLOAD_MESSAGE = "Provider did not expose a request payload";

export interface RemoteCompactionRequest {
  modelRegistry: Pick<ModelRegistry, "streamSimple">;
  model: Model<Api>;
  context: Context;
  reasoning: ThinkingLevel;
  sessionId: string;
  thinkingBudgets?: ThinkingBudgets;
  /** Apply the current Pi image policy to both fresh input and replayed opaque checkpoint history. */
  blockImages?: boolean;
  /** Pi's provider retry setting; Codex caps compaction retries below it. */
  maxRetries?: number;
  maxRetryDelayMs?: number;
  signal: AbortSignal;
  /** Pi origins of the context's user messages, used to align provider user items with Pi roles. */
  userItemOrigins?: readonly UserItemOrigin[];
  priorCheckpoint?: { identity: ProviderIdentity; marker: string; replacementHistory: readonly JsonObject[] };
  providerRequest?: ProviderRequestSnapshot;
  onPrepared?: () => void;
  fetch?: typeof globalThis.fetch;
}

export interface RemoteCompactionResponse {
  item: JsonObject;
  promptInput: JsonObject[];
  identity: ProviderIdentity;
  usage: Usage;
  images: ImageEstimates;
  /** Whether each promptInput item came from Pi context that Codex would not retain. */
  contextual: boolean[];
}

export function mergeRemoteCompactionHeader(headers: ProviderHeaders): ProviderHeaders {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find((key) => key.toLowerCase() === "x-codex-beta-features");
  const features = new Set(((existingKey ? merged[existingKey] : "") ?? "")
    .split(",").map((feature) => feature.trim()).filter(Boolean));
  features.add(REMOTE_COMPACTION_FEATURE);
  if (existingKey && existingKey !== "x-codex-beta-features") delete merged[existingKey];
  merged["x-codex-beta-features"] = [...features].join(",");
  return merged;
}

function objectItems(input: unknown): JsonObject[] {
  if (!Array.isArray(input) || !input.every(isObject)) {
    throw new CodexCompactionProtocolError("Prepared compaction payload has invalid input items");
  }
  return input;
}

export async function requestRemoteCompaction(request: RemoteCompactionRequest): Promise<RemoteCompactionResponse> {
  request.signal.throwIfAborted();
  const model = structuredClone(request.model);
  const context = structuredClone(request.context);
  const configured = capableModel(model);
  if (!configured) throw new CodexCompactionProtocolError("Model is not configured for remote compaction");
  const retries = compactionRetryLimit(request.maxRetries);
  let preparedPayload: JsonObject | undefined;
  let sentInput: JsonObject[] | undefined;
  let identity: ProviderIdentity | undefined;
  let images: ImageEstimates | undefined;
  let contextual: boolean[] | undefined;
  const baseFetch = request.fetch ?? globalThis.fetch;
  for (let retry = 0; ; retry++) {
    request.signal.throwIfAborted();
    const attempt = new CompactionAttempt();
    const collector = createCompactionCollector();
    let usage: Usage | undefined;
    let compactionCount = 0;
    let fetched = false;
    const routedFetch: typeof globalThis.fetch = async (input, init) => {
      try {
        request.signal.throwIfAborted();
        if (!identity) throw new CodexCompactionProtocolError(MISSING_PAYLOAD_MESSAGE);
        const actual = normalizeUrl(input instanceof Request ? input.url : String(input));
        const defaultEndpoint = deriveEndpoint(identity.baseUrl, identity.api);
        if (actual !== defaultEndpoint && actual !== identity.endpoint) {
          throw new CodexCompactionProtocolError(`Provider requested unexpected compaction endpoint ${actual}`);
        }
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        if (method.toUpperCase() !== "POST") throw new CodexCompactionProtocolError("Remote compaction request must use POST");
        if (fetched) throw new CodexCompactionProtocolError("Provider exceeded the single-request compaction attempt budget");
        fetched = true;
      } catch (error) {
        attempt.blockRetry(error);
        throw error;
      }
      try {
        // Endpoint overrides are same-origin HTTP routes; authentication remains assembled by Pi.
        const actual = normalizeUrl(input instanceof Request ? input.url : String(input));
        const response = actual === identity!.endpoint ? await baseFetch(input, init)
          : input instanceof Request
            ? await baseFetch(new Request(identity!.endpoint, new Request(input, init)))
            : await baseFetch(identity!.endpoint, init);
        return attempt.observeResponse(response, request.signal);
      } catch (error) {
        attempt.fetchFailed(error);
        throw error;
      }
    };
    try {
      const stream = request.modelRegistry.streamSimple(model, structuredClone(context), {
        signal: request.signal,
        // Pi pools WebSockets without comparing handshake headers; V2 needs its feature header on every request.
        transport: "sse",
        reasoning: request.reasoning === "off" ? undefined : request.reasoning,
        thinkingBudgets: request.thinkingBudgets,
        sessionId: request.sessionId,
        timeoutMs: REQUEST_TIMEOUT_MS,
        // Only the outer V2 loop retries; provider HTTP retries would multiply the global budget.
        maxRetries: 0,
        maxRetryDelayMs: request.maxRetryDelayMs,
        transformHeaders: mergeRemoteCompactionHeader,
        fetch: routedFetch,
        onPayload: async (payload, preparedModel) => {
          try {
            request.signal.throwIfAborted();
            if (!sameModel(configured.identity, preparedModel)) {
              throw new CodexCompactionProtocolError("Provider resolved an unexpected compaction model");
            }
            const resolved = capableModel(model, preparedModel.baseUrl);
            if (!resolved) throw new CodexCompactionProtocolError("Resolved provider endpoint is incompatible with remote compaction");
            if (identity && !sameBackend(identity, resolved.identity)) {
              throw new CodexCompactionProtocolError("Resolved provider backend changed during remote compaction retries");
            }
            identity = resolved.identity;
            const prior = request.priorCheckpoint?.identity;
            if (prior && !sameBackend(prior, identity)) {
              throw new CodexCompactionProtocolError("The active opaque checkpoint belongs to a different resolved provider backend");
            }
            if (preparedPayload) {
              if (!isObject(payload) || payload.model !== model.id) {
                throw new CodexCompactionProtocolError("Provider payload used an unexpected model");
              }
              // Re-authenticate each attempt, but never let a new serialization change the compacted input.
              request.onPrepared?.();
              return structuredClone(preparedPayload);
            }
            if (!isObject(payload)) throw new CodexCompactionProtocolError("Prepared compaction payload must be an object");
            const applied = applyProviderRequest(payload, resolved, request.providerRequest,
              contextUserItems(payload.input, request.userItemOrigins));
            const adapted = request.blockImages
              ? { ...applied.payload, input: withoutInputImages(objectItems(applied.payload.input)) } : applied.payload;
            const checkpoint = request.priorCheckpoint && request.blockImages
              ? { ...request.priorCheckpoint, replacementHistory: withoutInputImages(request.priorCheckpoint.replacementHistory) }
              : request.priorCheckpoint;
            const payloadItems = objectItems(adapted.input);
            const contextItems = new Set(payloadItems.filter((_, index) => applied.contextual[index]));
            const estimates = await estimateImages([...payloadItems, ...checkpoint?.replacementHistory ?? []], request.signal);
            const prepared = prepareRemoteCompactionPayload(adapted, checkpoint, (history) => ({
              ...history,
              input: trimToolOutputsToContextWindow(objectItems(history.input), history.instructions, preparedModel.contextWindow, estimates),
            }));
            if (prepared.model !== model.id) throw new CodexCompactionProtocolError("Provider payload used an unexpected model");
            const sent = objectItems(prepared.input).slice(0, -1);
            contextual = sent.map((item) => contextItems.has(item));
            sentInput = structuredClone(sent);
            images = estimates;
            preparedPayload = structuredClone(prepared);
            request.onPrepared?.();
            return prepared;
          } catch (error) {
            attempt.blockRetry(error);
            throw error;
          }
        },
        onProviderStreamEvent: (event) => {
          request.signal.throwIfAborted();
          const transient = attempt.observeEvent(event);
          if (transient) throw transient;
          try {
            if (isObject(event) && event.type === "response.output_item.done" && isObject(event.item) &&
                (event.item.type === "compaction" || event.item.type === "compaction_summary") && ++compactionCount > 1) {
              throw new CodexCompactionProtocolError("Remote compaction returned duplicate compaction output events");
            }
            collector.observe(event);
          } catch (error) {
            attempt.blockRetry(error);
            throw error;
          }
        },
      });
      for await (const event of stream) {
        request.signal.throwIfAborted();
        if (event.type === "error") throw new Error(event.error.errorMessage ?? "Codex compaction request failed");
        if (event.type === "done") usage = event.message.usage;
      }
      request.signal.throwIfAborted();
      if (attempt.fatal) throw attempt.fatal.error;
      if (!sentInput || !identity || !images || !contextual) throw new CodexCompactionProtocolError(MISSING_PAYLOAD_MESSAGE);
      if (!usage) throw new CodexCompactionProtocolError("Provider stream ended without a completed message");
      return { item: collector.finish(), promptInput: sentInput, identity, usage, images, contextual };
    } catch (error) {
      request.signal.throwIfAborted();
      if (attempt.fatal) throw attempt.fatal.error;
      const evidence = attempt.retryEvidence();
      if (!evidence || retry >= retries) throw error;
      await waitForCompactionRetry(evidence, retry, request.maxRetryDelayMs, request.signal);
    }
  }
}
