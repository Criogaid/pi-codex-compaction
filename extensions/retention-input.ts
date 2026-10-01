// Adapt Responses messages to Codex rust-v0.159.2's metadata-free retained groups.
// Context markers mirror core/src/context; XML is parsed at this boundary, not by the budget core.
// Pi message origins stand in for Codex's separate contextual messages where Pi merges them into user items.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { SaxesParser } from "saxes";
import { historyGroups, inputText, matchesMarkedText, trimWhiteSpace } from "./history-groups.js";
import { estimateImages, type ImageEstimates } from "./image-budget.js";
import { isObject, type JsonObject } from "./protocol.js";
import type { RetentionInput } from "./retention.js";

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
const EXTERNAL_PREFIX = "<external_";

function contextual(text: string): boolean {
  if (CONTEXT_MARKERS.some((markers) => matchesMarkedText(text, markers))) return true;
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
  return finished && !invalid && trimWhiteSpace(hookRunId).length > 0 && textFields === 1;
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
/** Pi sends user shell commands and hidden extension messages as user items; Codex treats them as context. */
export type UserItemOrigin = "user" | "context";

function origin(message: AgentMessage): UserItemOrigin {
  return message.role === "bashExecution" || (message.role === "custom" && !message.display) ? "context" : "user";
}

/** Origins of the provider's user items, in order; Pi's Responses adapter skips empty content arrays. */
export function userItemOrigins(messages: readonly AgentMessage[]): UserItemOrigin[] {
  return messages.flatMap((message) => convertToLlm([message])
    .filter((llm) => llm.role === "user" && (typeof llm.content === "string" || llm.content.length > 0))
    .map(() => origin(message)));
}

function isUserItem(item: JsonObject): boolean {
  return (item.type === undefined || item.type === "message") && item.role === "user";
}

/** Match provider user items to Pi origins; a changed user sequence falls back to text classification. */
export function contextUserItems(input: unknown, origins: readonly UserItemOrigin[] | undefined): ReadonlySet<JsonObject> {
  const users = Array.isArray(input) ? input.filter(isObject).filter(isUserItem) : [];
  if (!origins || users.length !== origins.length) return new Set();
  return new Set(users.filter((_, index) => origins[index] === "context"));
}

// Pi prepends an expanded skill to the user's text; Codex keeps the skill as a separate contextual message.
function withoutSkillBlocks(item: JsonObject): JsonObject | undefined {
  if (!Array.isArray(item.content)) return item;
  let changed = false;
  const content = item.content.flatMap((part: unknown) => {
    if (!isObject(part) || part.type !== "input_text" || typeof part.text !== "string") return [part];
    const skill = parseSkillBlock(part.text);
    if (!skill) return [part];
    changed = true;
    return skill.userMessage ? [{ ...part, text: skill.userMessage }] : [];
  });
  if (!changed) return item;
  return content.length ? { ...item, content } : undefined;
}

export async function prepareRetention(
  input: readonly JsonObject[],
  signal: AbortSignal,
  options: { images?: ImageEstimates; contextual?: readonly boolean[] } = {},
): Promise<RetentionInput> {
  const contextual = new Set(input.filter((_, index) => options.contextual?.[index]));
  const groups = historyGroups(input).flatMap((group) => {
    signal.throwIfAborted();
    if (contextual.has(group.source) || !isUserMessage(group.source)) return [];
    const source = withoutSkillBlocks(group.source);
    return source ? [{ ...group, source }] : [];
  });
  return { groups, images: options.images ?? await estimateImages(groups.map((group) => group.source), signal) };
}
