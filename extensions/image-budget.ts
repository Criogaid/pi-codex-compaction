// Own Codex image estimates and the adapter to Pi's image decoder.
// Decode serially; cancellation is checked between decodes because Pi exposes no decode abort hook.
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { isInputImage, type JsonObject } from "./protocol.js";
import { approximateTokensFromBytes } from "./text-budget.js";

const RESIZED_IMAGE_BYTES_ESTIMATE = 7_373;
const ORIGINAL_IMAGE_PATCH_SIZE_PX = 32;
const ORIGINAL_IMAGE_MAX_PATCHES = 10_000;
const MAX_CACHED_ORIGINAL_IMAGES = 32;
const DIMENSION_PROBE_LIMIT = Number.MAX_SAFE_INTEGER;

async function inlineOriginalTokens(url: string): Promise<number | undefined> {
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
  return Math.min(ORIGINAL_IMAGE_MAX_PATCHES,
    Math.ceil(decoded.originalWidth / ORIGINAL_IMAGE_PATCH_SIZE_PX) *
    Math.ceil(decoded.originalHeight / ORIGINAL_IMAGE_PATCH_SIZE_PX));
}

/** Snapshot costs for the exact image objects in input; the retention core only reads this map. */
export async function imageTokenCounts(input: readonly JsonObject[], signal: AbortSignal): Promise<ReadonlyMap<JsonObject, number>> {
  const result = new Map<JsonObject, number>();
  const originalCache = new Map<string, number>();
  const resizedTokens = approximateTokensFromBytes(RESIZED_IMAGE_BYTES_ESTIMATE);
  for (const item of input) {
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      signal.throwIfAborted();
      if (!isInputImage(part)) continue;
      let tokens = resizedTokens;
      if (part.detail === "original") {
        if (typeof part.file_id === "string") tokens = ORIGINAL_IMAGE_MAX_PATCHES;
        else if (typeof part.image_url === "string") {
          const cached = originalCache.get(part.image_url);
          tokens = cached ?? await inlineOriginalTokens(part.image_url) ?? resizedTokens;
          originalCache.delete(part.image_url);
          originalCache.set(part.image_url, tokens);
          if (originalCache.size > MAX_CACHED_ORIGINAL_IMAGES) {
            const oldest = originalCache.keys().next().value;
            if (oldest !== undefined) originalCache.delete(oldest);
          }
        }
      }
      signal.throwIfAborted();
      result.set(part, tokens);
    }
  }
  return result;
}
