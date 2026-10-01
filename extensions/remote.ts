// Own V2 request adaptation; Pi's model registry owns authentication and provider dispatch.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Context, Model, ProviderHeaders, ThinkingBudgets, Transport, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { capableModel, deriveEndpoint, normalizeUrl, sameBackend, sameModel, type ProviderIdentity, type RemoteCompactionApi } from "./capability.js";
import { trimToolOutputsToContextWindow } from "./context-window.js";
import { estimateImages, type ImageEstimates } from "./image-budget.js";
import { contextUserItems, type UserItemOrigin } from "./retention-input.js";
import { CodexCompactionProtocolError, createCompactionCollector, isObject, type JsonObject, prepareRemoteCompactionPayload } from "./protocol.js";

const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;
const MISSING_PAYLOAD_MESSAGE = "Provider did not expose a request payload";

export interface RemoteCompactionRequest {
  modelRegistry: Pick<ModelRegistry, "streamSimple">;
  model: Model<RemoteCompactionApi>;
  context: Context;
  reasoning: ThinkingLevel;
  sessionId: string;
  transport?: Transport;
  thinkingBudgets?: ThinkingBudgets;
  /** Pi's provider retry setting; Codex caps compaction retries below it. */
  maxRetries?: number;
  maxRetryDelayMs?: number;
  websocketConnectTimeoutMs?: number;
  signal: AbortSignal;
  /** Pi origins of the context's user messages, used to align provider user items with Pi roles. */
  userItemOrigins?: readonly UserItemOrigin[];
  priorCheckpoint?: { identity: ProviderIdentity; marker: string; replacementHistory: readonly JsonObject[] };
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
  const configured = capableModel(request.model);
  if (!configured) throw new CodexCompactionProtocolError("Model is not configured for remote compaction");
  const overridesEndpoint = configured.identity.endpoint !== deriveEndpoint(configured.identity.baseUrl, configured.identity.api);
  const collector = createCompactionCollector();
  let sentInput: JsonObject[] | undefined;
  let identity: ProviderIdentity | undefined;
  let usage: Usage | undefined;
  let images: ImageEstimates | undefined;
  let contextual: boolean[] | undefined;
  const baseFetch = request.fetch ?? globalThis.fetch;
  const routedFetch: typeof globalThis.fetch = async (input, init) => {
    if (!identity) throw new CodexCompactionProtocolError(MISSING_PAYLOAD_MESSAGE);
    const actual = normalizeUrl(input instanceof Request ? input.url : String(input));
    const defaultEndpoint = deriveEndpoint(identity.baseUrl, identity.api);
    if (actual !== defaultEndpoint && actual !== identity.endpoint) {
      throw new CodexCompactionProtocolError(`Provider requested unexpected compaction endpoint ${actual}`);
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "POST") throw new CodexCompactionProtocolError("Remote compaction request must use POST");
    if (actual === identity.endpoint) return baseFetch(input, init);
    // Endpoint overrides are same-origin HTTP routes; authentication remains assembled by Pi.
    return input instanceof Request
      ? baseFetch(new Request(identity.endpoint, new Request(input, init)))
      : baseFetch(identity.endpoint, init);
  };
  const stream = request.modelRegistry.streamSimple(request.model, request.context, {
    signal: request.signal,
    transport: overridesEndpoint ? "sse" : request.transport,
    reasoning: request.reasoning === "off" ? undefined : request.reasoning,
    thinkingBudgets: request.thinkingBudgets,
    sessionId: request.sessionId,
    timeoutMs: REQUEST_TIMEOUT_MS,
    websocketConnectTimeoutMs: request.websocketConnectTimeoutMs,
    maxRetries: Math.min(request.maxRetries ?? MAX_RETRIES, MAX_RETRIES),
    maxRetryDelayMs: request.maxRetryDelayMs,
    transformHeaders: mergeRemoteCompactionHeader,
    fetch: routedFetch,
    onPayload: async (payload, preparedModel) => {
      if (!sameModel(configured.identity, preparedModel)) {
        throw new CodexCompactionProtocolError("Provider resolved an unexpected compaction model");
      }
      const resolved = capableModel(request.model, preparedModel.baseUrl);
      if (!resolved) throw new CodexCompactionProtocolError("Resolved provider endpoint is incompatible with remote compaction");
      identity = resolved.identity;
      const prior = request.priorCheckpoint?.identity;
      if (prior && !sameBackend(prior, identity)) {
        throw new CodexCompactionProtocolError("The active opaque checkpoint belongs to a different resolved provider backend");
      }
      const contextItems = contextUserItems(isObject(payload) ? payload.input : undefined, request.userItemOrigins);
      const payloadItems = isObject(payload) && Array.isArray(payload.input) ? payload.input.filter(isObject) : [];
      const estimates = await estimateImages([...payloadItems, ...request.priorCheckpoint?.replacementHistory ?? []], request.signal);
      const prepared = prepareRemoteCompactionPayload(payload, request.priorCheckpoint, (history) => ({
        ...history,
        input: trimToolOutputsToContextWindow(objectItems(history.input), history.instructions, request.model.contextWindow, estimates),
      }));
      if (prepared.model !== request.model.id) throw new CodexCompactionProtocolError("Provider payload used an unexpected model");
      const sent = objectItems(prepared.input).slice(0, -1);
      contextual = sent.map((item) => contextItems.has(item));
      sentInput = structuredClone(sent);
      images = estimates;
      request.onPrepared?.();
      return prepared;
    },
    onProviderStreamEvent: (event) => {
      request.signal.throwIfAborted();
      collector.observe(event);
    },
  });
  for await (const event of stream) {
    request.signal.throwIfAborted();
    if (event.type === "error") throw new Error(event.error.errorMessage ?? "Codex compaction request failed");
    if (event.type === "done") usage = event.message.usage;
  }
  request.signal.throwIfAborted();
  if (!sentInput || !identity || !images || !contextual) throw new CodexCompactionProtocolError(MISSING_PAYLOAD_MESSAGE);
  if (!usage) throw new CodexCompactionProtocolError("Provider stream ended without a completed message");
  return { item: collector.finish(), promptInput: sentInput, identity, usage, images, contextual };
}
