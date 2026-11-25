// Own the versioned checkpoint format, endpoint binding, exact Pi session projection, and request-time replay projection.
// Normalize legacy fingerprints from their creation-time branch without rewriting session entries.
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionProjection,
  buildSessionContext,
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type ProjectedSessionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  isObject,
  isObjectArray,
  type JsonObject,
  PI_COMPACTION_SUMMARY_PREFIX,
  PI_COMPACTION_SUMMARY_SUFFIX,
  REMOTE_COMPACTION_PROTOCOL,
  validateCompactionItem,
} from "./protocol.js";
import {
  normalizeUrl,
  type ProviderIdentity,
} from "./capability.js";

const CHECKPOINT_KIND = "pi-codex-compaction";
export const CHECKPOINT_VERSION = 1;
const EXTENSION_PACKAGE = "@criogaid/pi-codex-compaction";

interface CheckpointBase extends ProviderIdentity {
  kind: typeof CHECKPOINT_KIND;
  checkpointId: string;
  protocol: typeof REMOTE_COMPACTION_PROTOCOL;
  replacementHistory: JsonObject[];
  keptMessageFingerprints: string[];
  createdAt: string;
}

export type CodexCheckpointDetails = CheckpointBase & (
  | { version: typeof CHECKPOINT_VERSION; textSummary?: never }
  | { version: 2; textSummary: string }
);

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
    (value.version !== CHECKPOINT_VERSION && value.version !== 2) ||
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
    !Array.isArray(value.keptMessageFingerprints) ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  if (value.version === 2) {
    if (typeof value.textSummary !== "string" || !value.textSummary.trim()) return undefined;
  } else if (value.textSummary !== undefined) return undefined;
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
    !isObjectArray(value.replacementHistory) ||
    value.replacementHistory.length === 0 ||
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
  if (details.version === 2) return details;
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

export type CheckpointResolution =
  | { readonly state: "none" }
  | { readonly state: "invalid" }
  | { readonly state: "parsed"; readonly details: CodexCheckpointDetails };

export function resolveLatestCheckpoint(entries: SessionEntry[]): CheckpointResolution {
  const entry = getLatestCompactionEntry(entries);
  if (!entry || !isObject(entry.details) || entry.details.kind !== CHECKPOINT_KIND) return { state: "none" };

  // A checkpoint's ancestors are immutable, so its normalized details are stable per entry.
  let details = checkpoints.get(entry);
  if (details === undefined) {
    const parsed = parseCheckpointDetails(entry.details);
    details = parsed ? normalizeLegacyFingerprints(entries, entry, parsed) : null;
    checkpoints.set(entry, details);
  }
  return details ? { state: "parsed", details } : { state: "invalid" };
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
  // A text layer summarizes only the dropped suffix; its retained tail still travels as Pi messages.
  return { start, end: details.version === 2 ? start + 1 : end };
}

/** Expand the opaque base and each Pi-framed text layer once at the private marker; persisted textSummary stays raw. */
export function checkpointHistory(details: CodexCheckpointDetails): JsonObject[] {
  return details.version === 2 ? [...details.replacementHistory, {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `${PI_COMPACTION_SUMMARY_PREFIX}${details.textSummary}${PI_COMPACTION_SUMMARY_SUFFIX}` }],
  }] : details.replacementHistory;
}

/** Validate the old coverage and the new cut against the same canonical projection. */
export function prepareCheckpointLayer(entries: readonly SessionEntry[], firstKeptEntryId: string, details: CodexCheckpointDetails) {
  const messages = withoutSystemMessages(buildSessionContext([...entries], entries.at(-1)?.id ?? null).messages);
  const range = checkpointRange(messages, details);
  if (!range) throw new Error("The previous opaque checkpoint could not be projected safely");
  const retained = keptMessages(entries, firstKeptEntryId);
  const cut = messages.length - retained.length;
  if (cut <= range.start || !retained.every((message, index) =>
    fingerprintMessage(message) === fingerprintMessage(messages[cut + index]))) {
    throw new Error("The text layer cut is not an exact canonical suffix");
  }
  return {
    messages: messages.slice(range.end, cut),
    retained,
  };
}

export function createLayeredCheckpointDetails(prior: CodexCheckpointDetails, layer: ReturnType<typeof prepareCheckpointLayer>, summary: string): CodexCheckpointDetails {
  const details = parseCheckpointDetails({
    ...prior,
    version: 2,
    checkpointId: randomUUID(),
    createdAt: new Date().toISOString(),
    textSummary: summary,
    keptMessageFingerprints: layer.retained.map(fingerprintMessage),
  });
  if (!details) throw new Error("Created an invalid layered checkpoint");
  return details;
}

// The range counts conversation messages, but system deltas keep their original slots in the request.
function projectCheckpointRange(
  messages: readonly AgentMessage[],
  range: NonNullable<ReturnType<typeof checkpointRange>>,
  checkpointId: string,
): AgentMessage[] {
  const projected: AgentMessage[] = [];
  let index = 0;
  for (const message of messages) {
    if (message.role === "system") {
      projected.push(message);
      continue;
    }
    if (index === range.start) projected.push(markerMessage(checkpointId, message.timestamp));
    else if (index < range.start || index >= range.end) projected.push(message);
    index++;
  }
  return projected;
}

// Pi derives each request from the canonical transcript; request-local edits replace content, not provenance.
function provenance(message: AgentMessage): string {
  return JSON.stringify([
    message.role,
    message.timestamp,
    message.role === "toolResult" ? message.toolCallId : message.role === "custom" ? message.customType : null,
  ]);
}

/**
 * Project Pi's final request transcript after every extension's `context` handler, so load order cannot change
 * what those handlers see or what replays. The checkpoint must match the canonical transcript exactly. Request
 * messages traced to its summary or retained messages become one marker at the first of them; inserted, edited,
 * later, and system messages keep their places.
 * Return undefined when the request omits the summary or a compacted source cannot be matched unambiguously.
 */
export function projectCheckpointTranscript(
  request: readonly AgentMessage[],
  canonical: readonly AgentMessage[],
  details: CodexCheckpointDetails,
): AgentMessage[] | undefined {
  const source = withoutSystemMessages(canonical);
  const range = checkpointRange(source, details);
  if (!range) return undefined;
  // Unchanged retained messages keep the exact projection and its cached request prefix.
  const exact = checkpointRange(withoutSystemMessages(request), details);
  if (exact) return projectCheckpointRange(request, exact, details.checkpointId);
  const summary = provenance(source[range.start]);
  const available = new Map<string, boolean>();
  for (let i = range.start; i < range.end; i++) {
    const key = provenance(source[i]);
    available.set(key, !available.has(key));
  }
  const live = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    if (index < range.start || index >= range.end) live.add(provenance(source[index]));
  }
  const projected: AgentMessage[] = [];
  let marked = false;
  let matchedSummary = false;
  for (const message of request) {
    if (message.role === "system") {
      projected.push(message);
      continue;
    }
    const key = provenance(message);
    const unique = available.get(key);
    if (unique === undefined) {
      projected.push(message);
      continue;
    }
    if (!unique || live.has(key)) return undefined;
    available.set(key, false);
    matchedSummary ||= key === summary;
    if (!marked) {
      projected.push(markerMessage(details.checkpointId, source[range.start].timestamp));
      marked = true;
    }
  }
  return matchedSummary ? projected : undefined;
}

/** Project a full transcript the way the `context_with_system` handler projects an unchanged request. */
export function projectCheckpointRequest(
  messages: readonly AgentMessage[],
  details: CodexCheckpointDetails,
): AgentMessage[] | undefined {
  const range = checkpointRange(withoutSystemMessages(messages), details);
  return range && projectCheckpointRange(messages, range, details.checkpointId);
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
