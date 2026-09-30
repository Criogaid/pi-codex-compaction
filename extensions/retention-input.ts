// Adapt Responses messages to Codex rust-v0.159.2's metadata-free retained groups.
// Context markers mirror core/src/context; XML is parsed at this boundary, not by the budget core.
import { SaxesParser } from "saxes";
import { estimateImages, type ImageEstimates } from "./image-budget.js";
import type { JsonObject } from "./protocol.js";
import type { RetentionInput, HistoryGroup } from "./retention.js";

const CONTEXT_MARKERS: readonly (readonly [string, string])[] = [
  ["# AGENTS.md instructions", "</INSTRUCTIONS>"],
  ["<environment_context>", "</environment_context>"],
  ["<agent_message_board_notification>", "</agent_message_board_notification>"],
  ["<skill>", "</skill>"],
  ["<user_shell_command>", "</user_shell_command>"],
  ["<turn_aborted>", "</turn_aborted>"],
  ["<subagent_notification>", "</subagent_notification>"],
  ["<recommended_plugins>", "</recommended_plugins>"],
];
const RESIZE_NOTICE_MARKERS = ["<image_resize_notice>", "</image_resize_notice>"] as const;
const EXTERNAL_PREFIX = "<external_";

// Rust str::trim uses Unicode White_Space; JS trim additionally removes the BOM.
function trim(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}
function marked(text: string, [open, close]: readonly [string, string]): boolean {
  const asciiLower = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return asciiLower(text.slice(0, open.length)) === asciiLower(open) &&
    asciiLower(text.slice(-close.length)) === asciiLower(close);
}
function contextual(text: string): boolean {
  if (CONTEXT_MARKERS.some((markers) => marked(text, markers))) return true;
  if (text.startsWith(EXTERNAL_PREFIX)) {
    const delimiter = text.indexOf(">", EXTERNAL_PREFIX.length);
    if (delimiter >= 0 && text.endsWith(`</external_${text.slice(EXTERNAL_PREFIX.length, delimiter)}>`)) return true;
  }
  if (text.startsWith("<goal_context>") && text.endsWith("</goal_context>")) return true;
  if (/^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/.test(text)) return true;
  return (text.startsWith("Warning: apply_patch was requested via ") &&
    text.endsWith("Use the apply_patch tool instead of exec_command.")) ||
    text.startsWith("Warning: The maximum number of unified exec processes you can keep open is") ||
    text.startsWith("Warning: Your account was flagged for potentially high-risk cyber activity");
}

// quick-xml's struct deserializer accepts any root name and reads only the first root.
// A nonempty hook_run_id and exactly one direct text field are required; nested fields are ignored.
function hookPrompt(text: string): boolean {
  if (!text.includes("hook_run_id")) return false;
  const parser = new SaxesParser({ fragment: true });
  let depth = 0;
  let finished = false;
  let rootEnd = Infinity;
  let invalid = false;
  let hookRunId = "";
  let textFields = 0;
  let previousChild = false;
  parser.on("error", () => { if (parser.position <= rootEnd) invalid = true; });
  parser.on("opentag", (tag) => {
    if (finished) return;
    if (depth === 0) hookRunId = typeof tag.attributes.hook_run_id === "string" ? tag.attributes.hook_run_id : "";
    if (depth === 1) previousChild = true;
    depth++;
  });
  const recordText = (value: string) => {
    if (finished) return;
    if (depth === 0 && value.trim()) invalid = true;
    if (depth === 1 && value.replace(/^[\x20\t\r\n]+|[\x20\t\r\n]+$/g, "")) {
      if (textFields === 0 || previousChild) textFields++;
      previousChild = false;
    }
  };
  parser.on("text", recordText);
  parser.on("cdata", recordText);
  parser.on("closetag", () => {
    if (!finished && --depth === 0) { finished = true; rootEnd = parser.position; }
  });
  parser.write(text).close();
  return finished && !invalid && trim(hookRunId).length > 0 && textFields === 1;
}
function inputText(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "type" in value && value.type === "input_text" &&
    "text" in value && typeof value.text === "string" ? trim(value.text) : undefined;
}
function isUserMessage(item: JsonObject): boolean {
  if ((item.type !== undefined && item.type !== "message") || item.role !== "user" || !Array.isArray(item.content)) return false;
  let hasContext = false;
  let hasHook = false;
  let allHookOrContext = true;
  for (const part of item.content) {
    const text = inputText(part);
    if (text === undefined) { allHookOrContext = false; continue; }
    const hook = hookPrompt(text);
    const context = contextual(text);
    hasContext ||= context || hook;
    hasHook ||= hook;
    allHookOrContext &&= hook || context;
  }
  return (hasHook && allHookOrContext) || !hasContext;
}
function isResizeNotice(item: JsonObject): boolean {
  if ((item.type !== undefined && item.type !== "message") || item.role !== "developer" ||
    !Array.isArray(item.content) || item.content.length !== 1) return false;
  const text = inputText(item.content[0]);
  return text !== undefined && marked(text, RESIZE_NOTICE_MARKERS);
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

export async function prepareRetention(
  input: readonly JsonObject[],
  signal: AbortSignal,
  images?: ImageEstimates,
): Promise<RetentionInput> {
  const groups = historyGroups(input).filter((group) => {
    signal.throwIfAborted();
    return isUserMessage(group.source);
  });
  return { groups, images: images ?? await estimateImages(groups.map((group) => group.source), signal) };
}
