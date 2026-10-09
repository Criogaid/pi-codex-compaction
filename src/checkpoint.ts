// Own the versioned checkpoint format, endpoint binding, exact Pi session projection, and request-time replay projection.
// Normalize legacy fingerprints from their creation-time branch without rewriting session entries.
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, type Message } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type ProjectedSessionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isObject, type JsonObject, REMOTE_COMPACTION_PROTOCOL, validateCompactionItem } from "./protocol.js";
import {
  normalizeUrl,
  type ProviderIdentity,
} from "./capability.js";

export const CHECKPOINT_KIND = "pi-codex-compaction";
export const CHECKPOINT_VERSION = 1;
const EXTENSION_PACKAGE = "@criogaid/pi-codex-compaction";

export interface CodexCheckpointDetails extends ProviderIdentity {
  kind: typeof CHECKPOINT_KIND;
  version: typeof CHECKPOINT_VERSION;
  checkpointId: string;
  protocol: typeof REMOTE_COMPACTION_PROTOCOL;
  replacementHistory: JsonObject[];
  keptMessageFingerprints: string[];
  createdAt: string;
}

function orderedValue(value: unknown, compareKeys: (left: string, right: string) => number): unknown {
  if (Array.isArray(value)) return value.map((item) => orderedValue(item, compareKeys));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, child]) => [key, orderedValue(child, compareKeys)]),
  );
}

function digestMessage(message: AgentMessage, compareKeys: (left: string, right: string) => number): string {
  return createHash("sha256").update(JSON.stringify(orderedValue(message, compareKeys))).digest("hex");
}

// Session and context messages are replaced rather than mutated, so object identity keys both caches.
const fingerprints = new WeakMap<AgentMessage, string>();
const checkpoints = new WeakMap<SessionEntry, CodexCheckpointDetails | null>();

export function fingerprintMessage(message: AgentMessage): string {
  let fingerprint = fingerprints.get(message);
  if (fingerprint === undefined) {
    // Compare UTF-16 code units; persisted hashes must not depend on the process locale or ICU collation.
    fingerprint = digestMessage(message, (left, right) => left < right ? -1 : left > right ? 1 : 0);
    fingerprints.set(message, fingerprint);
  }
  return fingerprint;
}

export function checkpointMarker(checkpointId: string): string {
  return [
    `[PI_CODEX_REMOTE_CHECKPOINT:${checkpointId}]`,
    "The compressed chat history could not be loaded. Do not infer missing details.",
    `Ask the user to enable ${EXTENSION_PACKAGE} and reconnect to the model service that created it.`,
  ].join(" ");
}

export function fallbackSummary(checkpointId: string): string {
  return [
    `Earlier chat history was compressed by Codex Remote Compaction V2 (checkpoint ${checkpointId}).`,
    `To use it, keep ${EXTENSION_PACKAGE} enabled and connected to the original model service.`,
    "If it cannot be loaded, only Pi's retained recent messages are available; do not guess missing details.",
  ].join(" ");
}

// The persisted v1 summary identifies checkpoints written before the package was renamed.
function legacyFallbackSummary(checkpointId: string): string {
  return [
    `Codex Remote Compaction V2 checkpoint ${checkpointId} stores the older history opaquely.`,
    "Full replay requires @oipsanthony/pi-codex-compaction and the original provider endpoint and model.",
    "Without them, only Pi's retained recent messages remain available.",
  ].join(" ");
}

function markerMessage(checkpointId: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: checkpointMarker(checkpointId) }],
    timestamp,
  };
}

export function parseCheckpointDetails(value: unknown): CodexCheckpointDetails | undefined {
  if (!isObject(value)) return undefined;
  if (
    value.kind !== CHECKPOINT_KIND ||
    value.version !== CHECKPOINT_VERSION ||
    typeof value.checkpointId !== "string" ||
    value.checkpointId.length < 8 ||
    typeof value.provider !== "string" ||
    !value.provider ||
    typeof value.api !== "string" ||
    !value.api ||
    typeof value.modelId !== "string" ||
    !value.modelId ||
    typeof value.baseUrl !== "string" ||
    typeof value.endpoint !== "string" ||
    value.protocol !== REMOTE_COMPACTION_PROTOCOL ||
    !Array.isArray(value.replacementHistory) ||
    !Array.isArray(value.keptMessageFingerprints) ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  try {
    if (
      normalizeUrl(value.baseUrl) !== value.baseUrl ||
      normalizeUrl(value.endpoint) !== value.endpoint ||
      new URL(value.baseUrl).origin !== new URL(value.endpoint).origin
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (
    value.replacementHistory.length === 0 ||
    !value.replacementHistory.every(isObject) ||
    !value.keptMessageFingerprints.every(
      (fingerprint) => typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
    )
  ) {
    return undefined;
  }
  try {
    const item = validateCompactionItem(value.replacementHistory.at(-1));
    const parsed = structuredClone(value) as unknown as CodexCheckpointDetails;
    parsed.replacementHistory[parsed.replacementHistory.length - 1] = item;
    return parsed;
  } catch {
    return undefined;
  }
}

function retainedEntries(
  branchEntries: readonly SessionEntry[],
  leafId: string | null,
  firstKeptEntryId: string,
): ProjectedSessionEntry[] | undefined {
  const projection = buildSessionProjection([...branchEntries], leafId);
  const keptIndex = projection.entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
  return keptIndex < 0 ? undefined : projection.entries.slice(keptIndex);
}

/** Pi's context handlers see only non-system messages; Pi carries system messages separately. */
export function withoutSystemMessages<T extends { readonly role: string }>(messages: readonly T[]): T[] {
  return messages.filter((message) => message.role !== "system");
}

function conversationMessages(entries: readonly ProjectedSessionEntry[]): AgentMessage[] {
  // appendCompaction snapshots system messages separately from the retained conversation.
  return withoutSystemMessages(entries.flatMap((entry) => entry.messages));
}

export function keptMessages(branchEntries: readonly SessionEntry[], firstKeptEntryId: string): AgentMessage[] {
  const retained = retainedEntries(branchEntries, branchEntries.at(-1)?.id ?? null, firstKeptEntryId);
  if (!retained) throw new Error("Pi compaction cut point is not present in the active context");
  return conversationMessages(retained);
}

function normalizeLegacyFingerprints(
  entries: readonly SessionEntry[],
  entry: CompactionEntry,
  details: CodexCheckpointDetails,
): CodexCheckpointDetails {
  // Validate at the checkpoint's parent, never against later context edits.
  const retained = retainedEntries(entries, entry.parentId, entry.firstKeptEntryId);
  if (!retained) return details;
  const canonical = conversationMessages(retained);
  const matches = (messages: readonly AgentMessage[], fingerprint: (message: AgentMessage) => string) =>
    messages.length === details.keptMessageFingerprints.length &&
    messages.every((message, index) => fingerprint(message) === details.keptMessageFingerprints[index]);
  if (matches(canonical, fingerprintMessage)) return details;
  // V1 did not record its locale. Only normalize old hashes when the old ordering proves an exact match.
  const legacyFingerprint = (message: AgentMessage) => digestMessage(message, (left, right) => left.localeCompare(right));
  const raw = retained.flatMap((item) => sessionEntryToContextMessages(item.sourceEntry));
  if (!matches(canonical, legacyFingerprint) && !matches(raw, legacyFingerprint)) return details;
  return { ...details, keptMessageFingerprints: canonical.map(fingerprintMessage) };
}

export function latestCheckpoint(
  entries: readonly SessionEntry[],
): { entry: CompactionEntry<CodexCheckpointDetails>; details: CodexCheckpointDetails } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "compaction") continue;
    // A checkpoint's ancestors are immutable, so its normalized details are stable per entry.
    let details = checkpoints.get(entry);
    if (details === undefined) {
      const parsed = parseCheckpointDetails(entry.details);
      details = parsed ? normalizeLegacyFingerprints(entries, entry, parsed) : null;
      checkpoints.set(entry, details);
    }
    return details ? { entry: entry as CompactionEntry<CodexCheckpointDetails>, details } : undefined;
  }
  return undefined;
}

/** Locate the checkpoint summary and its exact retained messages in a conversation without system messages. */
function checkpointRange(
  messages: readonly AgentMessage[],
  details: CodexCheckpointDetails,
): { readonly start: number; readonly end: number } | undefined {
  const summaries = new Set([fallbackSummary(details.checkpointId), legacyFallbackSummary(details.checkpointId)]);
  const start = messages.findIndex(
    (message) => message.role === "compactionSummary" && summaries.has(message.summary),
  );
  if (start < 0) return undefined;
  const end = start + 1 + details.keptMessageFingerprints.length;
  if (end > messages.length) return undefined;
  for (let index = start + 1; index < end; index++) {
    if (fingerprintMessage(messages[index]) !== details.keptMessageFingerprints[index - start - 1]) {
      return undefined;
    }
  }
  return { start, end };
}

export function projectCheckpointContext(
  messages: readonly AgentMessage[],
  details: CodexCheckpointDetails,
): AgentMessage[] | undefined {
  const range = checkpointRange(messages, details);
  return range && [
    ...messages.slice(0, range.start),
    markerMessage(details.checkpointId, messages[range.start].timestamp),
    ...messages.slice(range.end),
  ];
}

// Pi derives each request from the canonical transcript; request-local edits replace content, not provenance.
function provenance(message: AgentMessage): string {
  return JSON.stringify([
    message.role,
    message.timestamp,
    message.role === "toolResult" ? message.toolCallId : message.role === "custom" ? message.customType : null,
  ]);
}

function withSystemHead(messages: readonly AgentMessage[], conversation: AgentMessage[]): AgentMessage[] {
  const head = getCurrentSystemMessage(messages.filter((message): message is Message => message.role === "system"));
  return head ? [head, ...conversation] : conversation;
}

/**
 * Project Pi's final request transcript after every extension's `context` handler, so load order cannot change
 * what those handlers see or what replays. The checkpoint must match the canonical transcript exactly. Request
 * messages traced to its summary or retained messages become one marker at the first of them; inserted, edited,
 * and later messages keep their places. Like a changed `context` result, system messages collapse into one head.
 * Return undefined when the request omits the summary or a request message traces to both compacted and live history.
 */
export function projectCheckpointTranscript(
  request: readonly AgentMessage[],
  canonical: readonly AgentMessage[],
  details: CodexCheckpointDetails,
): AgentMessage[] | undefined {
  const conversation = withoutSystemMessages(request);
  // Unchanged retained messages keep the exact projection and its cached request prefix.
  const exact = projectCheckpointContext(conversation, details);
  if (exact) return withSystemHead(request, exact);
  const source = withoutSystemMessages(canonical);
  const range = checkpointRange(source, details);
  if (!range) return undefined;
  const summary = provenance(source[range.start]);
  const compacted = new Set(source.slice(range.start, range.end).map(provenance));
  const live = new Set([...source.slice(0, range.start), ...source.slice(range.end)].map(provenance));
  if (!conversation.some((message) => provenance(message) === summary)) return undefined;
  const projected: AgentMessage[] = [];
  let marked = false;
  for (const message of conversation) {
    const key = provenance(message);
    if (!compacted.has(key)) {
      projected.push(message);
      continue;
    }
    if (live.has(key)) return undefined;
    if (!marked) projected.push(markerMessage(details.checkpointId, source[range.start].timestamp));
    marked = true;
  }
  return withSystemHead(request, projected);
}

/**
 * Project a full transcript the way Pi sends a request whose context handler changed messages:
 * handlers see only non-system messages, and Pi collapses the system messages into one head.
 */
export function projectCheckpointRequest(
  messages: readonly AgentMessage[],
  details: CodexCheckpointDetails,
): AgentMessage[] | undefined {
  const projected = projectCheckpointContext(withoutSystemMessages(messages), details);
  return projected && withSystemHead(messages, projected);
}

export function createCheckpointDetails(input: {
  identity: ProviderIdentity;
  replacementHistory: JsonObject[];
  keptMessages: readonly AgentMessage[];
  checkpointId?: string;
  createdAt?: string;
}): CodexCheckpointDetails {
  const details: CodexCheckpointDetails = {
    kind: CHECKPOINT_KIND,
    version: CHECKPOINT_VERSION,
    checkpointId: input.checkpointId ?? randomUUID(),
    ...input.identity,
    protocol: REMOTE_COMPACTION_PROTOCOL,
    replacementHistory: structuredClone(input.replacementHistory),
    keptMessageFingerprints: input.keptMessages.map(fingerprintMessage),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const parsed = parseCheckpointDetails(details);
  if (!parsed) throw new Error("Created an invalid Codex checkpoint");
  return parsed;
}
