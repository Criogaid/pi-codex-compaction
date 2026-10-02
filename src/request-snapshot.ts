// Own ordinary-request prompt and context snapshots that let compaction reuse Pi's projected request prefix,
// and build compaction's provider context the way Pi 0.99 builds an ordinary request.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getSystemMessageText, type Context, type Message, type Tool } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { sameBackend, sameModel, type CapableModel, type ProviderIdentity } from "./capability.js";
import { type CodexCheckpointDetails, fingerprintMessage, projectCheckpointRequest, withoutSystemMessages } from "./checkpoint.js";

const BLOCKED_IMAGE_TEXT = "Image reading is disabled.";

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
): PromptOverride | undefined {
  const scoped = snapshotFor(override, sessionId, target);
  const head = scoped && sourceHead(messages);
  return head && fingerprintMessage(head) === scoped.sourceFingerprint ? scoped : undefined;
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

/** Reuse the projected request while its source is an unchanged prefix, then append newer messages. */
export function reuseContextSnapshot(messages: AgentMessage[], snapshot: ContextSnapshot | undefined): AgentMessage[] {
  if (!snapshot) return messages;
  const source = requestSource(messages);
  if (source.length < snapshot.sourceFingerprints.length || snapshot.sourceFingerprints.some(
    (fingerprint, index) => fingerprintMessage(source[index]) !== fingerprint,
  )) return messages;
  return [...structuredClone(snapshot.messages), ...source.slice(snapshot.sourceFingerprints.length)];
}

/** Pi 0.99 applies per-run prompt overrides after context hooks by collapsing system messages into one head. */
export function applyPromptOverride(messages: Message[], override: PromptOverride): Message[] | undefined {
  const head = getCurrentSystemMessage(messages);
  if (!head) return undefined;
  const { sections: _sections, ...declarations } = head;
  return [{ ...declarations, content: override.text }, ...withoutSystemMessages(messages)];
}

/** The snapshots that the latest ordinary request left for compaction. */
export interface RequestSnapshots {
  readonly promptOverride?: PromptOverride;
  readonly context?: ContextSnapshot;
}

interface TrackedSnapshots {
  promptOverride?: PromptOverride;
  pendingSource?: { readonly sessionId: string; readonly fingerprints: readonly string[] };
  pendingContext?: ContextSnapshot;
  context?: ContextSnapshot;
}

/**
 * Follow one ordinary request through Pi's hooks: `context`, then `context_with_system`, then
 * `before_provider_request` for each provider attempt. State lives only as long as the Pi process.
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
  ): void {
    this.state.promptOverride = target && capturePromptOverride(canonical(), sessionId, target, systemPrompt());
    // Keep the pending snapshot for retries that prepare a payload without running context hooks again.
    this.state.context = this.state.pendingContext;
  }
}

/** What Pi would declare for an ordinary request whose transcript carries no system messages. */
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
 * session, model, and backend. Pi 0.99 transcripts declare the prompt and tools through system
 * messages, as ordinary requests do; `messages` is the transcript actually sent.
 */
export function compactionRequest(
  snapshots: RequestSnapshots,
  sessionId: string,
  target: CapableModel,
  current: AgentMessage[],
  declarations: RequestDeclarations,
): { readonly context: Context; readonly messages: AgentMessage[] } {
  const override = promptOverrideFor(snapshots.promptOverride, sessionId, target, current);
  const messages = reuseContextSnapshot(current, snapshotFor(snapshots.context, sessionId, target));
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
