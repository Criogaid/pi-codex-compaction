// Own Codex image byte estimates and the adapter to Pi's image decoder.
// Decode serially; cancellation is checked between decodes because Pi exposes no decode abort hook.
import { createHash } from "node:crypto";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { isInputImage, type JsonObject } from "./protocol.js";
import { approximateBytesForTokens } from "./text-budget.js";

export const RESIZED_IMAGE_BYTES_ESTIMATE = 7_373;
const ORIGINAL_IMAGE_PATCH_SIZE_PX = 32;
const ORIGINAL_IMAGE_MAX_PATCHES = 10_000;
const ORIGINAL_IMAGE_ESTIMATE_CACHE_SIZE = 32;
const DIMENSION_PROBE_LIMIT = Number.MAX_SAFE_INTEGER;

/** Byte estimates for input images; original-detail inline images are decoded ahead of lookup. */
export interface ImageEstimates {
  bytes(part: JsonObject): number;
}

async function inlineOriginalBytes(url: string): Promise<number | undefined> {
  const comma = url.indexOf(",");
  if (comma < 0 || !/^data:image\//i.test(url)) return undefined;
  const [mimeType, ...parameters] = url.slice("data:".length, comma).split(";");
  if (!parameters.some((parameter) => parameter.toLowerCase() === "base64")) return undefined;
  const payload = url.slice(comma + 1);
  const bytes = Buffer.from(payload, "base64");
  // Rust's standard base64 decoder rejects noncanonical padding and trailing bits.
  if (bytes.toString("base64") !== payload) return undefined;
  const decoded = await resizeImage(bytes, mimeType, {
    maxWidth: DIMENSION_PROBE_LIMIT, maxHeight: DIMENSION_PROBE_LIMIT, maxBytes: DIMENSION_PROBE_LIMIT,
  });
  if (!decoded) return undefined;
  return approximateBytesForTokens(Math.min(ORIGINAL_IMAGE_MAX_PATCHES,
    Math.ceil(decoded.originalWidth / ORIGINAL_IMAGE_PATCH_SIZE_PX) *
    Math.ceil(decoded.originalHeight / ORIGINAL_IMAGE_PATCH_SIZE_PX)));
}

// Like Codex, cache decode results, including failures, across requests in a SHA-1 keyed LRU.
const originalEstimateCache = new Map<string, number | undefined>();

async function cachedOriginalBytes(url: string): Promise<number | undefined> {
  const key = createHash("sha1").update(url).digest("hex");
  if (originalEstimateCache.has(key)) {
    const cached = originalEstimateCache.get(key);
    originalEstimateCache.delete(key);
    originalEstimateCache.set(key, cached);
    return cached;
  }
  const bytes = await inlineOriginalBytes(url);
  originalEstimateCache.set(key, bytes);
  if (originalEstimateCache.size > ORIGINAL_IMAGE_ESTIMATE_CACHE_SIZE) {
    const oldest = originalEstimateCache.keys().next().value;
    if (oldest !== undefined) originalEstimateCache.delete(oldest);
  }
  return bytes;
}

function contentParts(item: JsonObject): readonly unknown[] {
  if (Array.isArray(item.content)) return item.content;
  return (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
    Array.isArray(item.output) ? item.output : [];
}

function originalInlineUrl(part: JsonObject): string | undefined {
  return part.detail === "original" && typeof part.file_id !== "string" && typeof part.image_url === "string"
    ? part.image_url : undefined;
}

/** Decode original-detail inline images in message content and tool outputs; lookups survive cloning. */
export async function estimateImages(input: readonly JsonObject[], signal: AbortSignal): Promise<ImageEstimates> {
  const originals = new Map<string, number>();
  for (const item of input) {
    for (const part of contentParts(item)) {
      signal.throwIfAborted();
      if (!isInputImage(part)) continue;
      const url = originalInlineUrl(part);
      if (url === undefined || originals.has(url)) continue;
      originals.set(url, await cachedOriginalBytes(url) ?? RESIZED_IMAGE_BYTES_ESTIMATE);
    }
  }
  signal.throwIfAborted();
  return {
    bytes(part) {
      if (part.detail === "original" && typeof part.file_id === "string") {
        return approximateBytesForTokens(ORIGINAL_IMAGE_MAX_PATCHES);
      }
      const url = originalInlineUrl(part);
      if (url === undefined) return RESIZED_IMAGE_BYTES_ESTIMATE;
      const bytes = originals.get(url);
      if (bytes === undefined) throw new Error("Input image is missing its byte estimate");
      return bytes;
    },
  };
}
