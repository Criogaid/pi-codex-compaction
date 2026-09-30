// Own the opt-in diagnostic that compares a compaction payload with the last ordinary request.
// Prompt caching matches an exact prefix, so the first differing field or input item explains a miss.
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "./protocol.js";

export const CACHE_PROBE_LOG = join(tmpdir(), "pi-codex-compaction-cache-probe.log");

// Temporary: enabled by default while diagnosing cache misses. Remove this module afterwards.
const SUMMARY_CHARS = 160;

export function cacheProbeEnabled(): boolean {
  return true;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summarize(item: unknown): string {
  if (item === undefined) return "(none)";
  const typed = typeof item === "object" && item !== null ? item as JsonObject : {};
  const label = `${String(typed.type ?? "message")}${typeof typed.role === "string" ? `/${typed.role}` : ""}`;
  return `${label} ${JSON.stringify(item).slice(0, SUMMARY_CHARS)}`;
}

export function describeCachePrefix(previous: JsonObject, current: JsonObject): string {
  const fields = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((key) => key !== "input" && !same(previous[key], current[key]));
  const previousInput = Array.isArray(previous.input) ? previous.input : [];
  const currentInput = Array.isArray(current.input) ? current.input : [];
  let matched = 0;
  while (matched < previousInput.length && same(previousInput[matched], currentInput[matched])) matched++;
  const lines = [
    `Cache probe: differing fields: ${fields.join(", ") || "none"}; input prefix ${matched}/${previousInput.length} items.`,
  ];
  if (matched < previousInput.length) {
    lines.push(`input[${matched}] previous: ${summarize(previousInput[matched])}`);
    lines.push(`input[${matched}] compaction: ${summarize(currentInput[matched])}`);
  }
  return lines.join("\n");
}

/** Keep each probe result after the notification disappears. */
export function recordCacheProbe(text: string): void {
  try {
    appendFileSync(CACHE_PROBE_LOG, `[${new Date().toISOString()}]\n${text}\n\n`);
  } catch {
    // The notification still carries the result.
  }
}
