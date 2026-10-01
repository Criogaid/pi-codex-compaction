// Own Codex's history item groups and the marked-text matching that contextual fragments share.
// Reference: openai/codex rust-v0.159.2, compact_remote_history.rs and context-fragments/src/fragment.rs.
import type { JsonObject } from "./protocol.js";

const RESIZE_NOTICE_MARKERS = ["<image_resize_notice>", "</image_resize_notice>"] as const;

export interface HistoryGroup {
  readonly source: JsonObject;
  readonly notice?: JsonObject;
}

/** Rust str::trim uses Unicode White_Space; JS trim additionally removes the BOM. */
export function trimWhiteSpace(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/** Match Codex's ASCII case-insensitive start and end markers on already trimmed text. */
export function matchesMarkedText(text: string, [open, close]: readonly [string, string]): boolean {
  const asciiLower = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return asciiLower(text.slice(0, open.length)) === asciiLower(open) &&
    asciiLower(text.slice(-close.length)) === asciiLower(close);
}

/** Trimmed text of an input_text part, or undefined for any other part. */
export function inputText(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "type" in value && value.type === "input_text" &&
    "text" in value && typeof value.text === "string" ? trimWhiteSpace(value.text) : undefined;
}

function isResizeNotice(item: JsonObject): boolean {
  if ((item.type !== undefined && item.type !== "message") || item.role !== "developer" ||
    !Array.isArray(item.content) || item.content.length !== 1) return false;
  const text = inputText(item.content[0]);
  return text !== undefined && matchesMarkedText(text, RESIZE_NOTICE_MARKERS);
}

/** Group each item with an immediately following resize notice, as Codex's history_item_groups does. */
export function historyGroups(input: readonly JsonObject[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (let index = 0; index < input.length; index++) {
    const next = input[index + 1];
    groups.push({ source: input[index], notice: next && isResizeNotice(next) ? input[++index] : undefined });
  }
  return groups;
}
