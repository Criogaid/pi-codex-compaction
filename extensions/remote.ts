// Own V2 request adaptation; Pi's model registry owns authentication and provider dispatch.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Context, Model, ProviderHeaders, ThinkingBudgets, Transport, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { capableModel, deriveEndpoint, normalizeUrl, sameIdentity, type ProviderIdentity, type RemoteCompactionApi } from "./capability.js";
import { CodexCompactionProtocolError, createCompactionCollector, type JsonObject, prepareRemoteCompactionPayload } from "./protocol.js";

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
  priorCheckpoint?: { identity: ProviderIdentity; marker: string; replacementHistory: readonly JsonObject[] };
  onPrepared?: () => void;
  fetch?: typeof globalThis.fetch;
}

export interface RemoteCompactionResponse {
  item: JsonObject;
  promptInput: JsonObject[];
  identity: ProviderIdentity;
  usage: Usage;
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

export async function requestRemoteCompaction(request: RemoteCompactionRequest): Promise<RemoteCompactionResponse> {
  request.signal.throwIfAborted();
  const configured = capableModel(request.model);
  if (!configured) throw new CodexCompactionProtocolError("Model is not configured for remote compaction");
  const overridesEndpoint = configured.identity.endpoint !== deriveEndpoint(configured.identity.baseUrl, configured.identity.api);
  const collector = createCompactionCollector();
  let sentInput: JsonObject[] | undefined;
  let identity: ProviderIdentity | undefined;
  let usage: Usage | undefined;
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
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (!(headers.get("x-codex-beta-features") ?? "").split(",").map((value) => value.trim()).includes(REMOTE_COMPACTION_FEATURE)) {
      throw new CodexCompactionProtocolError("Provider omitted the Remote Compaction V2 feature header");
    }
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
    onPayload: (payload, preparedModel) => {
      if (preparedModel.api !== request.model.api || preparedModel.provider !== request.model.provider || preparedModel.id !== request.model.id) {
        throw new CodexCompactionProtocolError("Provider resolved an unexpected compaction model");
      }
      const resolved = capableModel(request.model, preparedModel.baseUrl);
      if (!resolved) throw new CodexCompactionProtocolError("Resolved provider endpoint is incompatible with remote compaction");
      identity = resolved.identity;
      const prior = request.priorCheckpoint?.identity;
      if (prior && !sameIdentity(prior, identity)) {
        throw new CodexCompactionProtocolError("The active opaque checkpoint belongs to a different resolved provider identity");
      }
      const prepared = prepareRemoteCompactionPayload(payload, request.priorCheckpoint);
      if (prepared.model !== request.model.id) throw new CodexCompactionProtocolError("Provider payload used an unexpected model");
      if (!Array.isArray(prepared.input) || !prepared.input.every((item: unknown): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item))) {
        throw new CodexCompactionProtocolError("Prepared compaction payload has invalid input items");
      }
      sentInput = structuredClone(prepared.input.slice(0, -1));
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
  if (!sentInput || !identity) throw new CodexCompactionProtocolError(MISSING_PAYLOAD_MESSAGE);
  if (!usage) throw new CodexCompactionProtocolError("Provider stream ended without a completed message");
  return { item: collector.finish(), promptInput: sentInput, identity, usage };
}
