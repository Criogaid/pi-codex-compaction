// Own the versioned checkpoint format, endpoint binding, and exact Pi session projection.
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type JsonObject, REMOTE_COMPACTION_PROTOCOL, validateCompactionItem } from "./protocol.js";
import {
  CODEX_API,
  OPENAI_RESPONSES_API,
  normalizeUrl,
  type ProviderIdentity,
} from "./capability.js";

export const CHECKPOINT_KIND = "pi-codex-compaction";
export const CHECKPOINT_VERSION = 1;
export const REPLACEMENT_BYTE_BUDGET = 8 * 1024 * 1024;

export interface CodexCheckpointDetails extends ProviderIdentity {
  kind: typeof CHECKPOINT_KIND;
  version: typeof CHECKPOINT_VERSION;
  checkpointId: string;
  protocol: typeof REMOTE_COMPACTION_PROTOCOL;
  replacementHistory: JsonObject[];
  keptMessageFingerprints: string[];
  createdAt: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function fingerprintMessage(message: AgentMessage): string {
  return createHash("sha256").update(JSON.stringify(stableValue(message))).digest("hex");
}

export function checkpointMarker(checkpointId: string): string {
  return [
    `[PI_CODEX_REMOTE_CHECKPOINT:${checkpointId}]`,
    "Opaque checkpoint injection failed. Do not infer missing history; tell the user to re-enable",
    "@oipsanthony/pi-codex-compaction with the checkpoint's provider and model.",
  ].join(" ");
}

export function fallbackSummary(checkpointId: string): string {
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
    (value.api !== CODEX_API && value.api !== OPENAI_RESPONSES_API) ||
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
    ) ||
    serializedBytes(value.replacementHistory) > REPLACEMENT_BYTE_BUDGET
  ) {
    return undefined;
  }
  try {
    validateCompactionItem(value.replacementHistory.at(-1));
  } catch {
    return undefined;
  }
  return structuredClone(value) as unknown as CodexCheckpointDetails;
}

export function latestCheckpoint(
  entries: readonly SessionEntry[],
): { entry: CompactionEntry<CodexCheckpointDetails>; details: CodexCheckpointDetails } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "compaction") continue;
    const details = parseCheckpointDetails(entry.details);
    return details
      ? { entry: entry as CompactionEntry<CodexCheckpointDetails>, details }
      : undefined;
  }
  return undefined;
}

export function projectCheckpointContext(
  messages: readonly AgentMessage[],
  details: CodexCheckpointDetails,
): AgentMessage[] | undefined {
  const summary = fallbackSummary(details.checkpointId);
  const summaryIndex = messages.findIndex(
    (message) => message.role === "compactionSummary" && message.summary === summary,
  );
  if (summaryIndex < 0) return undefined;
  const keptStart = summaryIndex + 1;
  const keptEnd = keptStart + details.keptMessageFingerprints.length;
  if (keptEnd > messages.length) return undefined;
  for (let index = keptStart; index < keptEnd; index++) {
    if (
      fingerprintMessage(messages[index]) !== details.keptMessageFingerprints[index - keptStart]
    ) {
      return undefined;
    }
  }
  return [
    ...messages.slice(0, summaryIndex),
    markerMessage(details.checkpointId, messages[summaryIndex].timestamp),
    ...messages.slice(keptEnd),
  ];
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
