// Own ordinary-request prompt and context snapshots that let compaction reuse Pi's projected request prefix,
// and build compaction's provider context the way Pi 0.99 builds an ordinary request.
import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getSystemMessageText, type Context, type Message, type Tool } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { sameBackend, sameModel, type CapableModel, type ProviderIdentity } from "./capability.js";
import { type CodexCheckpointDetails, fingerprintMessage, projectCheckpointRequest, withoutSystemMessages } from "./checkpoint.js";
import { BLOCKED_IMAGE_TEXT, CodexCompactionProtocolError, isObject, type JsonObject } from "./protocol.js";
import { contextUserItems, userItemOrigins } from "./retention-input.js";

/**
 * In Pi 0.99.1 and 1.0.4 these settings affect presentation, not provider inputs. Every other setting,
 * including unknown future ones, stays in the reuse key, so changing it drops the wire snapshot.
 */
const INTERFACE_ONLY_SETTINGS: ReadonlySet<string> = new Set([
  "autocompleteMaxVisible", "collapseChangelog", "doubleEscapeAction", "editorPaddingX", "externalEditor",
  "fullscreenCopyOnSelect", "fullscreenExitOutput", "fullscreenScrollbar", "fullscreenWheelScrollLines",
  "hideThinkingBlock", "lastChangelogVersion", "markdown", "outputPad", "quietStartup", "showCacheMissNotices",
  "showHardwareCursor", "terminal", "theme", "treeFilterMode", "tuiMode", "warnings",
]);

interface SnapshotScope {
  readonly sessionId: string;
  readonly identity: ProviderIdentity;
}

export interface PromptOverride extends SnapshotScope {
  readonly sourceFingerprint: string;
  readonly text: string;
}

export interface ContextSnapshot extends SnapshotScope {
  readonly sourceFingerprints: readonly string[];
  readonly messages: readonly AgentMessage[];
}

/** Snapshots apply only to the session, model, and backend that produced them. */
export function snapshotFor<T extends SnapshotScope>(
  snapshot: T | undefined,
  sessionId: string,
  target: CapableModel,
): T | undefined {
  return snapshot?.sessionId === sessionId && sameModel(snapshot.identity, target.model) &&
    sameBackend(snapshot.identity, target.identity) ? snapshot : undefined;
}

function sourceHead(messages: readonly AgentMessage[]) {
  return getCurrentSystemMessage(convertToLlm([...messages]));
}

// Collapse source system state only for matching; the snapshot keeps Pi's actual projected transcript for sending.
function requestSource(messages: readonly AgentMessage[]): AgentMessage[] {
  const head = sourceHead(messages);
  const conversation = withoutSystemMessages(messages);
  return head ? [head, ...conversation] : conversation;
}

/** Context handlers see only conversation messages; a snapshot needs them to equal the persisted ones. */
export function matchesConversation(fingerprints: readonly string[], canonical: readonly AgentMessage[]): boolean {
  const conversation = withoutSystemMessages(canonical);
  return fingerprints.length === conversation.length &&
    fingerprints.every((fingerprint, index) => fingerprintMessage(conversation[index]) === fingerprint);
}

/**
 * Pi does not expose a run's forced prompt, so a difference between `ctx.getSystemPrompt()` and the
 * persisted head counts as one. A stale head only drops the override later, because compaction
 * requires the head fingerprint to match again.
 */
export function capturePromptOverride(
  canonical: readonly AgentMessage[],
  sessionId: string,
  target: CapableModel,
  text: string,
): PromptOverride | undefined {
  const head = sourceHead(canonical);
  if (!head || text === getSystemMessageText(head)) return undefined;
  return { sessionId, identity: target.identity, sourceFingerprint: fingerprintMessage(head), text };
}

export function promptOverrideFor(
  override: PromptOverride | undefined,
  sessionId: string,
  target: CapableModel,
  messages: readonly AgentMessage[],
  currentPrompt: string,
): PromptOverride | undefined {
  const scoped = snapshotFor(override, sessionId, target);
  const head = scoped && sourceHead(messages);
  return head && fingerprintMessage(head) === scoped.sourceFingerprint &&
    (currentPrompt === scoped.text || currentPrompt === getSystemMessageText(head)) ? scoped : undefined;
}

export function captureContextSnapshot(
  sessionId: string,
  target: CapableModel,
  source: readonly AgentMessage[],
  projected: readonly AgentMessage[],
): ContextSnapshot {
  return {
    sessionId,
    identity: target.identity,
    sourceFingerprints: requestSource(source).map(fingerprintMessage),
    messages: structuredClone(projected),
  };
}

function matchingSource(messages: readonly AgentMessage[], snapshot: Pick<ContextSnapshot, "sourceFingerprints">): AgentMessage[] | undefined {
  const source = requestSource(messages);
  return source.length < snapshot.sourceFingerprints.length || snapshot.sourceFingerprints.some(
    (fingerprint, index) => fingerprintMessage(source[index]) !== fingerprint,
  ) ? undefined : source;
}

/** Reuse the projected request while its source is an unchanged prefix, then append newer messages. */
export function reuseContextSnapshot(messages: AgentMessage[], snapshot: ContextSnapshot | undefined): AgentMessage[] {
  const source = snapshot && matchingSource(messages, snapshot);
  return source ? [...structuredClone(snapshot.messages), ...source.slice(snapshot.sourceFingerprints.length)] : messages;
}

/** Pi 0.99 applies per-run prompt overrides after context hooks by collapsing system messages into one head. */
export function applyPromptOverride(messages: Message[], override: PromptOverride): Message[] | undefined {
  const head = getCurrentSystemMessage(messages);
  if (!head) return undefined;
  const { sections: _sections, ...declarations } = head;
  return [{ ...declarations, content: override.text }, ...withoutSystemMessages(messages)];
}

/** Public Pi state that can change declarations or request parameters without changing the conversation. */
export interface ProviderRequestInputs {
  readonly systemPrompt: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly settings: ReturnType<ExtensionAPI["getSettings"]>;
  readonly activeTools: readonly string[];
  readonly tools: readonly ToolInfo[];
}

interface ProviderRequestFields {
  readonly instructions?: string;
  readonly tools?: readonly JsonObject[];
  readonly reasoning?: JsonObject;
  readonly parallel_tool_calls?: boolean;
  readonly text?: JsonObject;
  readonly prompt_cache_options?: { readonly mode?: string; readonly ttl?: string };
  readonly prompt_cache_key?: string;
  readonly prompt_cache_retention?: string;
  readonly service_tier?: string;
}

export interface ProviderRequestSnapshot extends SnapshotScope {
  readonly sourceFingerprints: readonly string[];
  /** The effective prompt `ctx.getSystemPrompt()` reported for the observed request. */
  readonly systemPrompt: string;
  readonly inputsKey: string;
  /** The same inputs after the observed run settled and Pi fell back to its base prompt options. */
  readonly settledInputsKey?: string;
  readonly fields: ProviderRequestFields;
  /** Absent when the observed input depends on server-side conversation state. */
  readonly prefix?: {
    readonly boundary: string;
    readonly contextLength: number;
    readonly input: readonly JsonObject[];
    readonly contextual: readonly boolean[];
  };
}

function requestInputsKey(target: CapableModel, inputs: ProviderRequestInputs): string {
  const settings = Object.fromEntries(Object.entries(inputs.settings).filter(([key]) => !INTERFACE_ONLY_SETTINGS.has(key)));
  return JSON.stringify({ model: target.model, ...inputs, settings });
}

function captureProviderRequest(
  context: ContextSnapshot, target: CapableModel, payload: unknown, inputs: ProviderRequestInputs,
): ProviderRequestSnapshot | undefined {
  if (!isObject(payload) || payload.model !== target.model.id ||
    !Array.isArray(payload.input) || !payload.input.every(isObject)) return undefined;
  const { instructions, tools, reasoning, parallel_tool_calls, prompt_cache_key, prompt_cache_retention, prompt_cache_options, service_tier, text } = payload;
  const verbosity = isObject(text) ? text.verbosity : undefined;
  const format = isObject(text) ? text.format : undefined;
  const mode = isObject(prompt_cache_options) ? prompt_cache_options.mode : undefined;
  const ttl = isObject(prompt_cache_options) ? prompt_cache_options.ttl : undefined;
  if ((instructions !== undefined && typeof instructions !== "string") ||
    (tools !== undefined && (!Array.isArray(tools) || !tools.every(isObject))) ||
    (reasoning !== undefined && !isObject(reasoning)) ||
    (parallel_tool_calls !== undefined && typeof parallel_tool_calls !== "boolean") ||
    (format !== undefined && !isObject(format)) ||
    (prompt_cache_options !== undefined && !isObject(prompt_cache_options)) ||
    (mode !== undefined && typeof mode !== "string") || (ttl !== undefined && typeof ttl !== "string") ||
    (prompt_cache_key !== undefined && typeof prompt_cache_key !== "string") ||
    (prompt_cache_retention !== undefined && typeof prompt_cache_retention !== "string") ||
    (service_tier !== undefined && typeof service_tier !== "string") ||
    (text !== undefined && !isObject(text)) || (verbosity !== undefined && typeof verbosity !== "string")) return undefined;
  const contextual = contextUserItems(payload.input, userItemOrigins(context.messages));
  // Copy policy only: a diagnostic response ID or prewarm operation belongs to the observed request.
  const cachePolicy = mode !== undefined || ttl !== undefined ? { mode, ttl } : undefined;
  const serverHistory = payload.previous_response_id != null || payload.conversation != null ||
    payload.input.some((item) => item.type === "item_reference");
  return {
    sessionId: context.sessionId, identity: context.identity, sourceFingerprints: context.sourceFingerprints,
    systemPrompt: inputs.systemPrompt, inputsKey: requestInputsKey(target, inputs),
    fields: structuredClone({ instructions, tools, reasoning, parallel_tool_calls, text, prompt_cache_key,
      prompt_cache_retention, prompt_cache_options: cachePolicy, service_tier }),
    prefix: serverHistory ? undefined : {
      boundary: `PI_CODEX_REQUEST_BOUNDARY_${randomUUID()}`, contextLength: context.messages.length,
      input: structuredClone(payload.input), contextual: payload.input.map((item) => contextual.has(item)),
    },
  };
}

/** Reuse the wire prompt and request parameters only with an unchanged source prefix and configuration. */
export function providerRequestFor(
  snapshots: RequestSnapshots, sessionId: string, target: CapableModel, current: readonly AgentMessage[], inputs: ProviderRequestInputs,
): ProviderRequestSnapshot | undefined {
  const snapshot = snapshotFor(snapshots.providerRequest, sessionId, target);
  const override = promptOverrideFor(snapshots.promptOverride, sessionId, target, current, inputs.systemPrompt);
  const effectiveInputs = override ? { ...inputs, systemPrompt: override.text } : inputs;
  const key = requestInputsKey(target, effectiveInputs);
  return snapshot && matchingSource(current, snapshot) &&
    (snapshot.inputsKey === key || snapshot.settledInputsKey === key) ? snapshot : undefined;
}

/** Replace the serialized prefix up to the private boundary; never let that boundary reach the provider. */
export function applyProviderRequest(
  payload: JsonObject, target: CapableModel, snapshot: ProviderRequestSnapshot | undefined,
  contextItems: ReadonlySet<JsonObject> = new Set(),
): { readonly payload: JsonObject; readonly contextual: readonly boolean[] } {
  const input = Array.isArray(payload.input) && payload.input.every(isObject) ? payload.input : undefined;
  if (!snapshot) return { payload, contextual: input?.map((item) => contextItems.has(item)) ?? [] };
  const compatible = sameBackend(snapshot.identity, target.identity) && sameModel(snapshot.identity, target.model) && payload.model === target.model.id;
  const prefix = snapshot.prefix;
  if (!prefix) return { payload: compatible ? { ...payload, ...structuredClone(snapshot.fields) } : payload,
    contextual: input?.map((item) => contextItems.has(item)) ?? [] };
  if (!input) throw new CodexCompactionProtocolError("Prepared request cannot locate the snapshot boundary");
  const matches = input.flatMap((item, index) => item.role === "user" && Array.isArray(item.content) &&
    item.content.length === 1 && isObject(item.content[0]) && item.content[0].type === "input_text" &&
    item.content[0].text === prefix.boundary ? [index] : []);
  if (matches.length !== 1) throw new CodexCompactionProtocolError("Prepared request must contain exactly one snapshot boundary");
  const boundaryIndex = matches[0];
  const suffix = input.slice(boundaryIndex + 1);
  if (!compatible) {
    const unmarked = [...input.slice(0, boundaryIndex), ...suffix];
    return { payload: { ...payload, input: unmarked }, contextual: unmarked.map((item) => contextItems.has(item)) };
  }
  return {
    payload: { ...payload, ...structuredClone(snapshot.fields), input: [...structuredClone(prefix.input), ...suffix] },
    contextual: [...prefix.contextual, ...suffix.map((item) => contextItems.has(item))],
  };
}

/** The snapshots that the latest ordinary request left for compaction. */
export interface RequestSnapshots {
  readonly promptOverride?: PromptOverride;
  readonly context?: ContextSnapshot;
  readonly providerRequest?: ProviderRequestSnapshot;
}

interface TrackedSnapshots {
  promptOverride?: PromptOverride;
  pendingSource?: { readonly sessionId: string; readonly fingerprints: readonly string[] };
  pendingContext?: ContextSnapshot;
  context?: ContextSnapshot;
  providerRequest?: ProviderRequestSnapshot;
}

/**
 * Follow one ordinary request through Pi's hooks: `context`, then `context_with_system`, then
 * `before_provider_request` for each provider attempt, then `agent_settled` when its run ends.
 * State lives only as long as the Pi process.
 */
export class RequestSnapshotTracker {
  private state: TrackedSnapshots = {};

  /** Forget every snapshot; a compaction that already started keeps the state it captured. */
  reset(): void {
    this.state = {};
  }

  /** The live snapshots a compaction reads; later provider requests may still update them. */
  current(): RequestSnapshots {
    return this.state;
  }

  /** `context`: record the conversation handlers received. Pi clones these messages per request, so hash only for V2. */
  recordContext(sessionId: string, target: CapableModel | undefined, messages: readonly AgentMessage[]): void {
    this.state.pendingSource = target ? { sessionId, fingerprints: messages.map(fingerprintMessage) } : undefined;
    this.state.pendingContext = undefined;
  }

  /** `context_with_system`: capture Pi's projected request when its source equals the persisted conversation. */
  recordProjectedRequest(
    sessionId: string,
    target: CapableModel | undefined,
    canonical: () => AgentMessage[],
    checkpoint: () => CodexCheckpointDetails | undefined,
    projected: readonly AgentMessage[],
  ): void {
    const pending = this.state.pendingSource;
    this.state.pendingSource = undefined;
    this.state.pendingContext = undefined;
    if (!target || pending?.sessionId !== sessionId) return;
    const messages = canonical();
    // Request-local, unpersisted messages cannot be aligned safely with the session's future suffix.
    if (!matchesConversation(pending.fingerprints, messages)) return;
    const prior = checkpoint();
    const source = prior ? projectCheckpointRequest(messages, prior) : messages;
    if (source) this.state.pendingContext = captureContextSnapshot(sessionId, target, source, projected);
  }

  /** `before_provider_request`: record the effective prompt and publish the pending context. */
  recordProviderRequest(
    sessionId: string,
    target: CapableModel | undefined,
    canonical: () => AgentMessage[],
    systemPrompt: () => string,
    observation: () => { readonly payload: unknown; readonly inputs: ProviderRequestInputs },
  ): void {
    this.state.promptOverride = target && capturePromptOverride(canonical(), sessionId, target, systemPrompt());
    // Keep the pending snapshot for retries that prepare a payload without running context hooks again.
    this.state.context = this.state.pendingContext;
    this.state.providerRequest = undefined;
    const context = target && snapshotFor(this.state.context, sessionId, target);
    if (context && target) {
      const { payload, inputs } = observation();
      this.state.providerRequest = captureProviderRequest(context, target, payload, inputs);
    }
  }

  /**
   * `agent_settled`: Pi drops the run's prompt options, so `ctx.getSystemPrompt()` reports the base prompt
   * until the next run. Accept that prompt for the run's last request only while every other input is unchanged;
   * the request prefix still comes from the transcript the snapshot's source fingerprints bind.
   */
  recordSettledRun(sessionId: string, target: CapableModel | undefined, inputs: () => ProviderRequestInputs): void {
    if (!target) return;
    const snapshot = snapshotFor(this.state.providerRequest, sessionId, target);
    if (!snapshot || snapshot.settledInputsKey !== undefined) return;
    const settled = inputs();
    if (requestInputsKey(target, { ...settled, systemPrompt: snapshot.systemPrompt }) !== snapshot.inputsKey) return;
    this.state.providerRequest = { ...snapshot, settledInputsKey: requestInputsKey(target, settled) };
  }
}

/** Pi's internal declarations let the provider serialize historical grammar tool calls correctly. */
export interface RequestDeclarations {
  readonly blockImages: boolean;
  readonly systemPrompt: () => string;
  readonly tools: () => Tool[];
}

// Mirror Pi 0.99's request-time image blocking, including its deduplicated placeholders.
function withoutImages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content) ||
        !message.content.some((part) => part.type === "image")) return message;
    const content = message.content
      .map((part) => part.type === "image" ? { type: "text" as const, text: BLOCKED_IMAGE_TEXT } : part)
      .filter((part, index, parts) => !(part.type === "text" && part.text === BLOCKED_IMAGE_TEXT && index > 0 &&
        parts[index - 1].type === "text" && (parts[index - 1] as { text: string }).text === BLOCKED_IMAGE_TEXT));
    return { ...message, content } as Message;
  });
}

/**
 * Build compaction's provider context from the current transcript and the snapshots bound to this
 * session, model, and backend. Preserve tool declarations for the request prefix and historical-call serialization.
 */
export function compactionRequest(
  snapshots: RequestSnapshots,
  sessionId: string,
  target: CapableModel,
  current: AgentMessage[],
  declarations: RequestDeclarations,
  providerRequest?: ProviderRequestSnapshot,
): { readonly context: Context; readonly messages: AgentMessage[] } {
  const override = snapshots.promptOverride && promptOverrideFor(snapshots.promptOverride, sessionId, target, current, declarations.systemPrompt());
  const reused = reuseContextSnapshot(current, snapshotFor(snapshots.context, sessionId, target));
  // The provider serializes the full transcript so grammar declarations and historical IDs keep their context.
  // This private user item marks the join; applyProviderRequest removes it and everything before it.
  const prefix = providerRequest?.prefix;
  const messages: AgentMessage[] = prefix ? [
    ...reused.slice(0, prefix.contextLength),
    { role: "user", content: prefix.boundary, timestamp: 0 },
    ...reused.slice(prefix.contextLength),
  ] : reused;
  const converted = convertToLlm(messages);
  const llmMessages = declarations.blockImages ? withoutImages(converted) : converted;
  const overridden = override && applyPromptOverride(llmMessages, override);
  if (overridden) return { context: { messages: overridden }, messages };
  if (llmMessages.some((message) => message.role === "system")) return { context: { messages: llmMessages }, messages };
  return {
    context: { systemPrompt: declarations.systemPrompt(), messages: llmMessages, tools: declarations.tools() },
    messages,
  };
}
