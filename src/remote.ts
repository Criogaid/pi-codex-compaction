// Own V2 request adaptation; Pi's model registry owns authentication and provider dispatch.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, ProviderHeaders, ThinkingBudgets, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { capableModel, deriveEndpoint, normalizeUrl, sameBackend, sameModel, type ProviderIdentity } from "./capability.js";
import { trimToolOutputsToContextWindow } from "./context-window.js";
import { estimateImages, type ImageEstimates } from "./image-budget.js";
import { contextUserItems, type UserItemOrigin } from "./retention-input.js";
import { CodexCompactionProtocolError, type CompactionPayload, createCompactionCollector, isObject, type JsonObject, prepareRemoteCompactionPayload, withoutInputImages } from "./protocol.js";
import { applyProviderRequest, type ProviderRequestSnapshot } from "./request-snapshot.js";
import { CompactionAttempt, compactionRetryLimit, waitForCompactionRetry } from "./remote-retry.js";

const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const REQUEST_TIMEOUT_MS = 300_000;
const MISSING_PAYLOAD_MESSAGE = "Provider did not expose a request payload";
const UNEXPECTED_PAYLOAD_MODEL = "Provider payload used an unexpected model";

/** Only an exhausted, explicitly transient request is eligible for layered recovery. */
export class RemoteCompactionTransientError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RemoteCompactionTransientError";
  }
}

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
  priorCheckpoint?: {
    identity: ProviderIdentity;
    marker: string;
    replacementHistory: readonly JsonObject[];
    /** Injected text layers at and after this offset are absorbed by the new opaque item. */
    contextualFrom?: number;
  };
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

function parseCompactionPayload(
  payload: unknown, snapshot: ProviderRequestSnapshot | undefined,
): CompactionPayload {
  if (!isObject(payload)) throw new CodexCompactionProtocolError("Prepared compaction payload must be an object");
  if (!Array.isArray(payload.input) || payload.input.findIndex((item: unknown) => !isObject(item)) !== -1) {
    throw new CodexCompactionProtocolError(snapshot?.prefix
      ? "Prepared request cannot locate the snapshot boundary" : "Prepared compaction payload has invalid input items");
  }
  // TypeScript narrows the validated properties, not the original object.
  return payload as CompactionPayload;
}

export async function requestRemoteCompaction(request: RemoteCompactionRequest): Promise<RemoteCompactionResponse> {
  request.signal.throwIfAborted();
  const model = structuredClone(request.model);
  const context = structuredClone(request.context);
  const configured = capableModel(model);
  if (!configured) throw new CodexCompactionProtocolError("Model is not configured for remote compaction");
  const retries = compactionRetryLimit(request.maxRetries);
  let prepared: (Pick<RemoteCompactionResponse, "promptInput" | "images" | "contextual"> & { readonly body: CompactionPayload }) | undefined;
  let identity: ProviderIdentity | undefined;
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
            if (prepared) {
              if (!isObject(payload) || payload.model !== model.id) {
                throw new CodexCompactionProtocolError(UNEXPECTED_PAYLOAD_MODEL);
              }
              // Re-authenticate each attempt, but never let a new serialization change the compacted input.
              request.onPrepared?.();
              return structuredClone(prepared.body);
            }
            const parsed = parseCompactionPayload(payload, request.providerRequest);
            const applied = applyProviderRequest(parsed, resolved, request.providerRequest,
              contextUserItems(parsed.input, request.userItemOrigins));
            const adapted = request.blockImages
              ? { ...applied.payload, input: withoutInputImages(applied.payload.input) } : applied.payload;
            const checkpoint = request.priorCheckpoint && request.blockImages
              ? { ...request.priorCheckpoint, replacementHistory: withoutInputImages(request.priorCheckpoint.replacementHistory) }
              : request.priorCheckpoint;
            const contextItems = new Set(adapted.input.filter((_, index) => applied.contextual[index]));
            const estimates = await estimateImages([...adapted.input, ...checkpoint?.replacementHistory ?? []], request.signal);
            const trackedCheckpoint = checkpoint && {
              ...checkpoint,
              onReplay: (items: readonly JsonObject[]) => {
                // Track injected object identities, never user-visible text equality.
                if (checkpoint.contextualFrom === undefined) return;
                for (const item of items.slice(checkpoint.contextualFrom)) contextItems.add(item);
              },
            };
            const body = prepareRemoteCompactionPayload(adapted, trackedCheckpoint, (history) => ({
              ...history,
              input: trimToolOutputsToContextWindow(history.input, history.instructions, preparedModel.contextWindow, estimates),
            }));
            // Boundary, marker, and trigger errors take precedence over a payload model mismatch.
            if (body.model !== model.id) throw new CodexCompactionProtocolError(UNEXPECTED_PAYLOAD_MODEL);
            const sent = body.input.slice(0, -1);
            const contextual = sent.map((item) => contextItems.has(item));
            prepared = { promptInput: structuredClone(sent), images: estimates, contextual, body: structuredClone(body) };
            request.onPrepared?.();
            return body;
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
      if (!prepared || !identity) throw new CodexCompactionProtocolError(MISSING_PAYLOAD_MESSAGE);
      if (!usage) throw new CodexCompactionProtocolError("Provider stream ended without a completed message");
      const { promptInput, images, contextual } = prepared;
      return { item: collector.finish(), promptInput, identity, usage, images, contextual };
    } catch (error) {
      request.signal.throwIfAborted();
      if (attempt.fatal) throw attempt.fatal.error;
      const evidence = attempt.retryEvidence();
      if (!evidence) throw error;
      if (retry >= retries) throw new RemoteCompactionTransientError(error);
      await waitForCompactionRetry(evidence, retry, request.maxRetryDelayMs, request.signal);
    }
  }
}
