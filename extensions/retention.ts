// Own Codex V2 retention for Pi message items, including its enabled image-budget policy.
// Reference: openai/codex rust-v0.159.2, compact_remote_v2.rs and compact_remote_v2_images.rs.
import { isInputImage, type JsonObject, validateCompactionItem } from "./protocol.js";
import { approximateTokenCount, truncateTextToTokenBudget } from "./text-budget.js";

export const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const IMAGE_OPEN_TAG = "<image>";
const IMAGE_CLOSE_TAG = "</image>";
const LOCAL_IMAGE_OPEN_PREFIX = "<image name=";

type TextPart = JsonObject & { type: "input_text" | "output_text"; text: string };
export interface HistoryGroup {
  readonly source: JsonObject;
  readonly notice?: JsonObject;
}
export interface RetentionInput {
  readonly groups: readonly HistoryGroup[];
  readonly images: ReadonlyMap<JsonObject, number>;
}
function isTextPart(part: unknown): part is TextPart {
  return typeof part === "object" && part !== null && "type" in part &&
    (part.type === "input_text" || part.type === "output_text") &&
    "text" in part && typeof part.text === "string";
}
function isTag(part: unknown, tag: string): boolean {
  return isTextPart(part) && part.type === "input_text" && part.text === tag;
}
function isImageOpenTag(part: unknown): boolean {
  return isTag(part, IMAGE_OPEN_TAG) || (isTextPart(part) && part.type === "input_text" &&
    part.text.startsWith(LOCAL_IMAGE_OPEN_PREFIX) && part.text.endsWith(">"));
}
function partTokenCount(part: unknown, images: ReadonlyMap<JsonObject, number>): number {
  if (isTextPart(part)) return approximateTokenCount(part.text);
  if (!isInputImage(part)) return 0;
  const tokens = images.get(part);
  if (tokens === undefined) throw new Error("Input image is missing its token estimate");
  return tokens;
}
function textTokenCount(item: JsonObject): number {
  return Array.isArray(item.content)
    ? item.content.reduce((tokens: number, part: unknown) => tokens + (isTextPart(part) ? approximateTokenCount(part.text) : 0), 0)
    : 0;
}
function truncateTextMessage(item: JsonObject, maxTokens: number): JsonObject | undefined {
  if (!Array.isArray(item.content)) return undefined;
  let remaining = maxTokens;
  const content: unknown[] = [];
  for (const part of item.content) {
    if (!isTextPart(part)) { content.push(part); continue; }
    if (remaining === 0) continue;
    const tokenCount = approximateTokenCount(part.text);
    const text = tokenCount <= remaining ? part.text : truncateTextToTokenBudget(part.text, remaining);
    remaining = Math.max(0, remaining - tokenCount);
    if (text) content.push({ ...part, text });
  }
  return content.length ? { ...item, content } : undefined;
}
function truncateImageMessage(item: JsonObject, maxTokens: number, images: ReadonlyMap<JsonObject, number>): JsonObject | undefined {
  if (!Array.isArray(item.content)) return undefined;
  const pending: unknown[] = [...item.content];
  const reversed: unknown[] = [];
  let remaining = maxTokens;
  while (pending.length) {
    const last = pending.length - 1;
    const imageIndex = isInputImage(pending[last]) ? last
      : isTag(pending[last], IMAGE_CLOSE_TAG) && last > 0 && isInputImage(pending[last - 1]) ? last - 1 : undefined;
    if (imageIndex !== undefined) {
      const start = imageIndex > 0 && isImageOpenTag(pending[imageIndex - 1]) ? imageIndex - 1 : imageIndex;
      const tokens = pending.slice(start).reduce((sum: number, part: unknown) => sum + partTokenCount(part, images), 0);
      const fits = tokens <= remaining;
      remaining = fits ? remaining - tokens : 0;
      if (fits) reversed.push(...pending.slice(start).reverse());
      pending.length = start;
      continue;
    }
    const part = pending.pop();
    if (!isTextPart(part)) { reversed.push(part); continue; }
    if (!remaining) continue;
    const tokens = approximateTokenCount(part.text);
    const text = tokens <= remaining ? part.text : truncateTextToTokenBudget(part.text, remaining);
    remaining = Math.max(0, remaining - tokens);
    if (text) reversed.push({ ...part, text });
  }
  return reversed.length ? { ...item, content: reversed.reverse() } : undefined;
}

/** Keep newest user groups within Codex's fixed budget, preserving image/label groups atomically. */
export function buildReplacementHistory({ groups, images }: RetentionInput, compactionItem: JsonObject): JsonObject[] {
  let remaining = RETAINED_MESSAGE_TOKEN_BUDGET;
  const reversed: JsonObject[] = [];
  for (let index = groups.length - 1; index >= 0 && remaining > 0; index--) {
    const { source, notice } = groups[index];
    const noticeTokens = notice ? Math.max(1, textTokenCount(notice)) : 0;
    const sourceTokens = Math.max(1, Array.isArray(source.content)
      ? source.content.reduce((sum: number, part: unknown) => sum + partTokenCount(part, images), 0) : 0);
    const hasImages = Array.isArray(source.content) && source.content.some(isInputImage);
    if (sourceTokens + noticeTokens <= remaining) {
      if (notice) reversed.push(notice);
      reversed.push(source);
      remaining -= sourceTokens + noticeTokens;
    } else if (remaining > noticeTokens) {
      const budget = remaining - noticeTokens;
      if (hasImages) remaining = 0;
      const truncated = hasImages ? truncateImageMessage(source, budget, images) : truncateTextMessage(source, budget);
      if (!truncated) continue;
      if (notice) reversed.push(notice);
      reversed.push(truncated);
      remaining = 0;
    } else if (hasImages) remaining = 0;
  }
  return [...structuredClone(reversed.reverse()), validateCompactionItem(compactionItem)];
}
