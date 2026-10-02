// Own Codex's pre-compaction tool-output trimming and its model-visible item estimate.
// Reference: openai/codex rust-v0.159.2, compact_remote_history.rs and context_manager/history.rs.
import { type ImageEstimates, RESIZED_IMAGE_BYTES_ESTIMATE } from "./image-budget.js";
import { isInputImage, isObject, type JsonObject } from "./protocol.js";
import { historyGroups, type HistoryGroup } from "./history-groups.js";
import { approximateTokenCount, approximateTokensFromBytes } from "./text-budget.js";

const EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
const DEFAULT_FUNCTION_NAMESPACE = "functions";
const TRUNCATED_OUTPUT_MESSAGE = "Output exceeded the available model context and was truncated";

function textBytes(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}
function jsonBytes(value: unknown): number {
  const json = value === undefined || value === null ? undefined : JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}
function reasoningBytes(value: unknown): number {
  return typeof value === "string" ? Math.max(0, Math.floor(textBytes(value) * 3 / 4) - 650) : 0;
}
function partBytes(part: unknown, images: ImageEstimates): number {
  if (!isObject(part)) return 0;
  if (part.type === "input_text" || part.type === "output_text") return textBytes(part.text);
  if (part.type === "encrypted_content") return Math.ceil(textBytes(part.encrypted_content) * 9 / 16);
  // Pi sends no audio parts.
  return isInputImage(part) ? images.bytes(part) : 0;
}
function contentBytes(content: unknown, images: ImageEstimates): number {
  if (typeof content === "string") return textBytes(content);
  return Array.isArray(content) ? content.reduce((sum: number, part: unknown) => sum + partBytes(part, images), 0) : 0;
}

function itemBytes(item: JsonObject, images: ImageEstimates): number {
  switch (item.type ?? "message") {
    case "message":
      return contentBytes(item.content, images);
    case "reasoning":
    case "compaction":
    case "compaction_summary":
    case "context_compaction":
      return reasoningBytes(item.encrypted_content);
    case "function_call":
      return textBytes(item.name) + textBytes(item.namespace ?? DEFAULT_FUNCTION_NAMESPACE) + textBytes(item.arguments);
    case "custom_tool_call":
      return textBytes(item.name) + textBytes(item.namespace ?? DEFAULT_FUNCTION_NAMESPACE) + textBytes(item.input);
    case "function_call_output":
      return contentBytes(item.output, images) + textBytes(item.call_id) + textBytes(item.name) + textBytes(item.namespace);
    case "custom_tool_call_output":
      return contentBytes(item.output, images) + textBytes(item.call_id) + textBytes(item.name);
    case "additional_tools":
    case "tool_search_output":
      return jsonBytes(item.tools);
    case "tool_search_call":
      return jsonBytes(item.arguments);
    case "local_shell_call":
    case "web_search_call":
      return jsonBytes(item.action);
    case "image_generation_call":
      return textBytes(item.revised_prompt) + (textBytes(item.result) > 0 ? RESIZED_IMAGE_BYTES_ESTIMATE : 0);
    default:
      return 0;
  }
}

export function itemTokenCount(item: JsonObject, images: ImageEstimates): number {
  return approximateTokensFromBytes(itemBytes(item, images));
}
function groupTokenCount({ source, notice }: HistoryGroup, images: ImageEstimates): number {
  return itemTokenCount(source, images) + (notice ? itemTokenCount(notice, images) : 0);
}

function rewrittenOutput(item: JsonObject): JsonObject | undefined {
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return { ...item, output: TRUNCATED_OUTPUT_MESSAGE };
  }
  return item.type === "tool_search_output" ? { ...item, tools: [] } : undefined;
}

/**
 * Replace trailing tool outputs until the estimate fits Codex's usable window.
 * A replaced output drops its attached notice; the first non-output group stops trimming.
 */
export function trimToolOutputsToContextWindow(
  input: readonly JsonObject[],
  instructions: unknown,
  contextWindow: number,
  images: ImageEstimates,
): JsonObject[] {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return [...input];
  const usableWindow = Math.floor(contextWindow * EFFECTIVE_CONTEXT_WINDOW_PERCENT / 100);
  const groups = historyGroups(input);
  let estimated = groups.reduce(
    (sum, group) => sum + groupTokenCount(group, images),
    approximateTokenCount(typeof instructions === "string" ? instructions : ""),
  );
  let consumed = 0;
  const rewritten: JsonObject[] = [];
  for (let index = groups.length - 1; index >= 0 && estimated > usableWindow; index--) {
    const group = groups[index];
    const replacement = rewrittenOutput(group.source);
    if (!replacement) break;
    estimated += itemTokenCount(replacement, images) - groupTokenCount(group, images);
    consumed += group.notice ? 2 : 1;
    rewritten.push(replacement);
  }
  return [...input.slice(0, input.length - consumed), ...rewritten.reverse()];
}
