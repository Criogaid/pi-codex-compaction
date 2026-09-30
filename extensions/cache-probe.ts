// Own temporary request snapshots and system-message diagnostics for compaction cache misses.
// Snapshots observe this extension's hooks; later handlers can still change the request.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, SystemMessage } from "@earendil-works/pi-ai";
import type { JsonObject } from "./protocol.js";

const CACHE_PROBE_STEM = "pi-codex-compaction-cache-probe";
export const CACHE_PROBE_LOG = join(tmpdir(), `${CACHE_PROBE_STEM}.log`);
const SUMMARY_CHARS = 160;
const DIFF_CONTEXT_CHARS = 200;

export interface CacheProbeSystems {
  readonly count: number;
  readonly messages: readonly {
    readonly index: number;
    readonly contentChars: number;
    readonly contentSha256: string;
    readonly contentPreview: string;
    readonly message: SystemMessage;
  }[];
}

export interface CacheProbeRequest {
  readonly capturedAt: string;
  readonly sessionId: string;
  readonly model: Pick<Model<Api>, "provider" | "api" | "id" | "baseUrl">;
  readonly systems: CacheProbeSystems | undefined;
  readonly payload: JsonObject;
}

export interface CacheProbeContext {
  readonly sessionId: string;
  readonly checkpointId: string | undefined;
  readonly projectCheckpointRequestCalled: boolean;
  readonly systemMessagesCollapsed: boolean;
  readonly sessionSystems: CacheProbeSystems;
  readonly projectedSystems: CacheProbeSystems;
}

// Temporary: enabled while diagnosing cache misses. Revert before release.
export function cacheProbeEnabled(): boolean {
  return true;
}

export function summarizeCacheProbeSystems(messages: readonly AgentMessage[]): CacheProbeSystems {
  const systems = messages.flatMap((message, index) => {
    if (message.role !== "system") return [];
    const content = typeof message.content === "string"
      ? message.content : message.content.map((part) => part.text).join("\n");
    return [{
      index,
      contentChars: content.length,
      contentSha256: createHash("sha256").update(content).digest("hex"),
      contentPreview: content.slice(0, SUMMARY_CHARS),
      message: structuredClone(message),
    }];
  });
  return { count: systems.length, messages: systems };
}

export function captureCacheProbeRequest(
  payload: JsonObject,
  sessionId: string,
  model: Model<Api>,
  systems: CacheProbeSystems | undefined,
): CacheProbeRequest {
  return {
    capturedAt: new Date().toISOString(),
    sessionId,
    model: { provider: model.provider, api: model.api, id: model.id, baseUrl: model.baseUrl },
    systems,
    payload: structuredClone(payload),
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function serializeItem(item: unknown): string {
  return item === undefined ? "(missing item)" : JSON.stringify(item);
}

export function describeCachePrefix(previous: JsonObject, current: JsonObject): string {
  const fields = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((key) => key !== "input" && !same(previous[key], current[key]));
  const previousInput = Array.isArray(previous.input) ? previous.input : [];
  const currentInput = Array.isArray(current.input) ? current.input : [];
  let matched = 0;
  while (matched < previousInput.length && matched < currentInput.length && same(previousInput[matched], currentInput[matched])) matched++;
  const lines = [
    `Cache probe: differing fields: ${fields.join(", ") || "none"}; input prefix ${matched}/${previousInput.length} items.`,
  ];
  if (matched < previousInput.length) {
    const previousText = serializeItem(previousInput[matched]);
    const currentText = serializeItem(currentInput[matched]);
    let charOffset = 0;
    while (charOffset < previousText.length && charOffset < currentText.length && previousText[charOffset] === currentText[charOffset]) charOffset++;
    const previousBytes = Buffer.from(previousText);
    const currentBytes = Buffer.from(currentText);
    let byteOffset = 0;
    while (byteOffset < previousBytes.length && byteOffset < currentBytes.length && previousBytes[byteOffset] === currentBytes[byteOffset]) byteOffset++;
    const start = Math.max(0, charOffset - DIFF_CONTEXT_CHARS);
    const end = charOffset + DIFF_CONTEXT_CHARS + 1;
    lines.push(`input[${matched}] first difference: JSON UTF-16 offset ${charOffset}, UTF-8 byte offset ${byteOffset} (zero-based).`);
    lines.push(`input[${matched}] previous length ${previousText.length}; window from ${start}: ${JSON.stringify(previousText.slice(start, end))}`);
    lines.push(`input[${matched}] compaction length ${currentText.length}; window from ${start}: ${JSON.stringify(currentText.slice(start, end))}`);
  }
  return lines.join("\n");
}

/** Save one immutable pair per compaction; filesystem failures remain diagnostic only. */
export function recordCacheProbe(
  previous: CacheProbeRequest | undefined,
  current: JsonObject,
  context: CacheProbeContext,
): string {
  const capturedAt = new Date().toISOString();
  const prefix = join(tmpdir(), `${CACHE_PROBE_STEM}-${randomUUID()}`);
  const previousPath = `${prefix}-previous.json`;
  const compactionPath = `${prefix}-compaction.json`;
  const contextPath = `${prefix}-context.json`;
  const report = [
    previous ? describeCachePrefix(previous.payload, current)
      : "Cache probe: no ordinary request was observed in this Pi process before compaction.",
    `Checkpoint: ${context.checkpointId ?? "none"}; projectCheckpointRequest called: ${context.projectCheckpointRequestCalled}; system messages collapsed: ${context.systemMessagesCollapsed}.`,
    `System messages: session ${context.sessionSystems.count}; projected ${context.projectedSystems.count}; ordinary context_with_system ${previous?.systems?.count ?? "unobserved"}.`,
    `Previous payload: ${previousPath}`,
    `Compaction payload: ${compactionPath}`,
    `Context: ${contextPath}`,
  ].join("\n");
  try {
    writeFileSync(previousPath, `${JSON.stringify(previous?.payload ?? null, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    writeFileSync(compactionPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    writeFileSync(contextPath, `${JSON.stringify({
      capturedAt,
      boundary: "pi-codex-compaction hooks; later handlers may change messages or payloads",
      previous: previous ? {
        capturedAt: previous.capturedAt,
        sessionId: previous.sessionId,
        model: previous.model,
        systems: previous.systems,
      } : null,
      compaction: context,
      report,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    appendFileSync(CACHE_PROBE_LOG, `[${capturedAt}]\n${report}\n\n`);
    return `${report}\n(${CACHE_PROBE_LOG})`;
  } catch (error) {
    // Diagnostic I/O must not change whether compaction succeeds; report partial snapshot paths.
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    return `${report}\nCache probe: could not finish writing snapshots or log (${code}).`;
  }
}
