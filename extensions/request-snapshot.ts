// Own ordinary-request prompt and context snapshots that let compaction reuse Pi's projected request prefix.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { sameBackend, sameModel, type CapableModel, type ProviderIdentity } from "./capability.js";
import { fingerprintMessage } from "./checkpoint.js";

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
  const conversation = messages.filter((message) => message.role !== "system");
  return head ? [head, ...conversation] : conversation;
}

/** Context handlers see only conversation messages; a snapshot needs them to equal the persisted ones. */
export function matchesConversation(fingerprints: readonly string[], canonical: readonly AgentMessage[]): boolean {
  const conversation = canonical.filter((message) => message.role !== "system");
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

/** Pi applies per-run prompt overrides after context hooks by collapsing system messages into one head. */
export function applyPromptOverride(messages: Message[], override: PromptOverride): Message[] | undefined {
  const head = getCurrentSystemMessage(messages);
  if (!head) return undefined;
  const { sections: _sections, ...declarations } = head;
  return [{ ...declarations, content: override.text }, ...messages.filter((message) => message.role !== "system")];
}
