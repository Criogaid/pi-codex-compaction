// Estimate a complete Responses input conservatively without treating opaque/image bytes as text.
import type { Api, Model } from "@earendil-works/pi-ai";
import { itemTokenCount } from "./context-window.js";
import type { ImageEstimates } from "./image-budget.js";
import { isInputImage, isObject, type JsonObject } from "./protocol.js";
import { approximateTokenCount } from "./text-budget.js";

const MAX_ESTIMATE = Number.MAX_SAFE_INTEGER;
const EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
const OPAQUE_ITEM_TYPES = new Set(["reasoning", "compaction", "compaction_summary", "context_compaction"]);

/**
 * Reserve the larger of the model's maximum output and the caller's requested reserve from
 * the floored 95% physical window. Invalid windows or reserves leave no verifiable budget.
 */
export function modelInputBudget(model: Model<Api>, reserveTokens = 0): number {
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 ||
      !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 0 ||
      !Number.isSafeInteger(reserveTokens) || reserveTokens < 0) return 0;
  return Math.max(0, Math.floor(model.contextWindow * EFFECTIVE_CONTEXT_WINDOW_PERCENT / 100) -
    Math.max(model.maxTokens, reserveTokens));
}

/**
 * Charge UTF-8 JSON for all plaintext, schemas, envelopes, and unknown fields. Substitute
 * Codex's semantic image/opaque estimates only at recognized Responses input positions.
 * This is a guard estimate, not a tokenizer guarantee; unestimable input saturates closed.
 */
export function estimateModelInput(payload: JsonObject, images: ImageEstimates): number {
  try {
    let semanticTokens = 0;
    const checkedImages: ImageEstimates = {
      bytes(part) {
        const bytes = images.bytes(part);
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid model input image estimate");
        return bytes;
      },
    };
    const addSemantic = (item: JsonObject) => {
      const tokens = itemTokenCount(item, checkedImages);
      if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Invalid model input item estimate");
      semanticTokens = Math.min(MAX_ESTIMATE, semanticTokens + tokens);
    };
    const content = (value: unknown): unknown => Array.isArray(value) ? value.map((part: unknown) => {
      if (!isObject(part)) return part;
      if (part.type === "encrypted_content" && typeof part.encrypted_content === "string") {
        addSemantic({ type: "message", content: [part] });
        return { ...part, encrypted_content: "" };
      }
      if (isInputImage(part)) {
        addSemantic({ type: "message", content: [part] });
        return typeof part.image_url === "string" ? { ...part, image_url: "" } : part;
      }
      return part;
    }) : value;
    const input = Array.isArray(payload.input) ? payload.input.map((item: unknown) => {
      if (!isObject(item)) return item;
      if (typeof item.type === "string" && OPAQUE_ITEM_TYPES.has(item.type) && typeof item.encrypted_content === "string") {
        addSemantic({ type: item.type, encrypted_content: item.encrypted_content });
        return { ...item, encrypted_content: "" };
      }
      if ((item.type ?? "message") === "message") return { ...item, content: content(item.content) };
      if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        return { ...item, output: content(item.output) };
      }
      if (item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0) {
        addSemantic({ type: item.type, result: item.result });
        return { ...item, result: "" };
      }
      return item;
    }) : payload.input;
    const serialized = JSON.stringify({ ...payload, input });
    return Math.min(MAX_ESTIMATE, semanticTokens + approximateTokenCount(serialized));
  } catch {
    // Missing image probes, cycles, and unsupported values must never appear to fit a model.
    return MAX_ESTIMATE;
  }
}
