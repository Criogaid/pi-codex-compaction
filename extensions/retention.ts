// Own Codex's metadata-free V2 retention policy for the message items produced by Pi.
// Reference: openai/codex rust-v0.159.2, compact_remote_v2.rs and utils/string/src/truncate.rs.
import { type JsonObject, validateCompactionItem } from "./protocol.js";

export const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const APPROX_BYTES_PER_TOKEN = 4;
const IMAGE_RESIZE_NOTICE_OPEN = "<image_resize_notice>";
const IMAGE_RESIZE_NOTICE_CLOSE = "</image_resize_notice>";

type TextPart = JsonObject & { type: "input_text" | "output_text"; text: string };
interface HistoryGroup {
  readonly source: JsonObject;
  readonly notice?: JsonObject;
}
function isTextPart(part: unknown): part is TextPart {
  return typeof part === "object" && part !== null && "type" in part &&
    (part.type === "input_text" || part.type === "output_text") &&
    "text" in part && typeof part.text === "string";
}
function approximateTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / APPROX_BYTES_PER_TOKEN);
}
function textTokenCount(item: JsonObject): number {
  if (!Array.isArray(item.content)) return 0;
  return item.content.reduce((tokens: number, part: unknown) => tokens +
    (isTextPart(part) ? approximateTokenCount(part.text) : 0), 0);
}
function isResizeNotice(item: JsonObject): boolean {
  if (item.role !== "developer" || !Array.isArray(item.content) || item.content.length !== 1) return false;
  const part: unknown = item.content[0];
  return isTextPart(part) && part.type === "input_text" &&
    part.text.trim().startsWith(IMAGE_RESIZE_NOTICE_OPEN) && part.text.trim().endsWith(IMAGE_RESIZE_NOTICE_CLOSE);
}
function truncateMiddle(text: string, maxTokens: number): string {
  const budgetBytes = maxTokens * APPROX_BYTES_PER_TOKEN;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= budgetBytes) return text;
  const prefixBudgetBytes = Math.floor(budgetBytes / 2);
  const suffixStartBytes = totalBytes - (budgetBytes - prefixBudgetBytes);
  let offsetBytes = 0;
  let prefix = "";
  let suffix = "";
  for (const character of text) {
    const endBytes = offsetBytes + Buffer.byteLength(character, "utf8");
    if (endBytes <= prefixBudgetBytes) prefix += character;
    else if (offsetBytes >= suffixStartBytes) suffix += character;
    offsetBytes = endBytes;
  }
  const removedTokens = Math.ceil((totalBytes - budgetBytes) / APPROX_BYTES_PER_TOKEN);
  return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
}
function truncateMessage(item: JsonObject, maxTokens: number): JsonObject | undefined {
  if (!Array.isArray(item.content)) return undefined;
  let remaining = maxTokens;
  const content: unknown[] = [];
  for (const part of item.content) {
    if (!isTextPart(part)) {
      // Codex's default path preserves media without charging it against the text budget.
      content.push(part);
      continue;
    }
    if (remaining === 0) continue;
    const tokenCount = approximateTokenCount(part.text);
    const text = tokenCount <= remaining ? part.text : truncateMiddle(part.text, remaining);
    remaining = Math.max(0, remaining - tokenCount);
    if (text) content.push({ ...part, text });
  }
  return content.length ? { ...item, content } : undefined;
}

/** Keep newest user message groups within the fixed Codex text budget, then append the opaque item. */
export function buildReplacementHistory(input: readonly JsonObject[], compactionItem: JsonObject): JsonObject[] {
  const groups: HistoryGroup[] = [];
  for (let index = 0; index < input.length; index++) {
    const source = input[index];
    const next = input[index + 1];
    const notice = next && isResizeNotice(next) ? input[++index] : undefined;
    if ((source.type === undefined || source.type === "message") && source.role === "user") {
      groups.push({ source, notice });
    }
  }
  let remaining = RETAINED_MESSAGE_TOKEN_BUDGET;
  const reversed: JsonObject[] = [];
  for (let index = groups.length - 1; index >= 0 && remaining > 0; index--) {
    const { source, notice } = groups[index];
    const noticeTokens = notice ? Math.max(1, textTokenCount(notice)) : 0;
    const sourceTokens = Math.max(1, textTokenCount(source));
    if (sourceTokens + noticeTokens <= remaining) {
      if (notice) reversed.push(notice);
      reversed.push(source);
      remaining -= sourceTokens + noticeTokens;
    } else if (remaining > noticeTokens) {
      const truncated = truncateMessage(source, remaining - noticeTokens);
      if (!truncated) continue;
      if (notice) reversed.push(notice);
      reversed.push(truncated);
      remaining = 0;
    }
  }
  return [...structuredClone(reversed.reverse()), validateCompactionItem(compactionItem)];
}
