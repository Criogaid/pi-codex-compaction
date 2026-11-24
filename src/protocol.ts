// Own Responses V2 item validation and checkpoint payload transformations.
export const REMOTE_COMPACTION_PROTOCOL = "remote-compaction-v2" as const;

export type JsonObject = Record<string, unknown>;
export type CompactionPayload = JsonObject & { readonly input: readonly JsonObject[] };

export class CodexCompactionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCompactionProtocolError";
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isObjectArray(value: unknown): value is JsonObject[] {
  // findIndex visits holes, which would become undefined when the array is spread.
  return Array.isArray(value) && value.findIndex((item: unknown) => !isObject(item)) === -1;
}

export function isInputImage(value: unknown): value is JsonObject {
  return isObject(value) && value.type === "input_image";
}

/** Pi's placeholder for a blocked image; replayed and fresh history must match it byte for byte. */
export const BLOCKED_IMAGE_TEXT = "Image reading is disabled.";

/** Apply Pi's current image policy to replayed Responses items without changing saved history. */
export function withoutInputImages(items: readonly JsonObject[]): JsonObject[] {
  return items.map((item) => {
    const field = item.role === "user" ? "content"
      : item.type === "function_call_output" || item.type === "custom_tool_call_output" ? "output" : undefined;
    const parts = field && item[field];
    if (!field || !Array.isArray(parts) || !parts.some(isInputImage)) return item;
    const blocked = parts.map((part: unknown) => isInputImage(part)
      ? { type: "input_text", text: BLOCKED_IMAGE_TEXT } : part);
    const isPlaceholder = (part: unknown) => isObject(part) && part.type === "input_text" && part.text === BLOCKED_IMAGE_TEXT;
    return { ...item, [field]: blocked.filter((part, index) =>
      !(index > 0 && isPlaceholder(part) && isPlaceholder(blocked[index - 1]))) };
  });
}

function isCompactionType(type: unknown): boolean {
  return type === "compaction" || type === "compaction_summary";
}

export function validateCompactionItem(
  value: unknown,
): JsonObject {
  if (
    !isObject(value) ||
    !isCompactionType(value.type) ||
    typeof value.encrypted_content !== "string" ||
    !value.encrypted_content
  ) {
    throw new CodexCompactionProtocolError(
      "Remote response did not contain a valid compaction item",
    );
  }
  return { ...structuredClone(value), type: "compaction" };
}

export interface CompactionCollector {
  observe(event: unknown): void;
  finish(): JsonObject;
}

/**
 * Count only output-item completion events. A successful terminal event ends collection,
 * and the response that completed must already have supplied the one compaction item.
 */
export function createCompactionCollector(): CompactionCollector {
  let outputs = 0;
  let item: JsonObject | undefined;
  let completedItem: JsonObject | undefined;
  return {
    observe(event) {
      if (completedItem || !isObject(event)) return;
      // A provider may restart its response when falling back from WebSocket to HTTP.
      if (event.type === "response.created") {
        item = undefined;
      }
      if (event.type === "response.output_item.done" && isObject(event.item) &&
          isCompactionType(event.item.type)) {
        if (++outputs > 1) {
          throw new CodexCompactionProtocolError("Remote compaction returned duplicate compaction output events");
        }
        item = validateCompactionItem(event.item);
      }
      // Pi exposes raw Codex events before normalizing the successful response.done alias.
      if (event.type === "response.completed" || event.type === "response.done") {
        const status = isObject(event.response) ? event.response.status : undefined;
        if (status !== "completed" && (event.type === "response.done" || status !== undefined)) {
          throw new CodexCompactionProtocolError("Remote compaction did not complete successfully");
        }
        if (!item) {
          throw new CodexCompactionProtocolError(
            "Remote compaction returned 0 compaction output events; expected exactly one",
          );
        }
        completedItem = item;
      }
      if (event.type === "response.failed" || event.type === "response.incomplete") {
        throw new CodexCompactionProtocolError("Remote compaction did not complete successfully");
      }
    },
    finish() {
      if (!completedItem) {
        throw new CodexCompactionProtocolError(
          "Remote compaction stream ended without response.completed",
        );
      }
      return completedItem;
    },
  };
}

function markerCount(item: JsonObject, marker: string): number {
  if (item.role !== "user" || !Array.isArray(item.content)) return 0;
  return item.content.reduce<number>((count, part) => isObject(part) && part.type === "input_text" &&
    typeof part.text === "string" ? count + part.text.split(marker).length - 1 : count, 0);
}

// Later request hooks may tag or join user text around the private marker; replace only the marker itself.
function replaceMarker(item: JsonObject, marker: string, replacementHistory: readonly JsonObject[], onReplay?: (items: readonly JsonObject[]) => void): JsonObject[] {
  const content = item.content as unknown[];
  const index = content.findIndex((part) => isObject(part) && part.type === "input_text" &&
    typeof part.text === "string" && part.text.includes(marker));
  const part = content[index] as JsonObject & { text: string };
  const at = part.text.indexOf(marker);
  const text = (value: string) => value.trim() ? [{ ...part, text: value }] : [];
  const before = [...content.slice(0, index), ...text(part.text.slice(0, at))];
  const after = [...text(part.text.slice(at + marker.length)), ...content.slice(index + 1)];
  const replayed = structuredClone(replacementHistory);
  onReplay?.(replayed);
  return [
    ...(before.length > 0 ? [{ ...item, content: before }] : []),
    ...replayed,
    ...(after.length > 0 ? [{ ...item, content: after }] : []),
  ];
}

function locateCheckpointMarker(input: readonly unknown[], marker: string): { index: number; item: JsonObject } {
  let total = 0;
  let location: { index: number; item: JsonObject } | undefined;
  for (const [index, item] of input.entries()) {
    if (!isObject(item)) continue;
    const count = markerCount(item, marker);
    if (count === 0) continue;
    total += count;
    location = total === 1 ? { index, item } : undefined;
  }
  if (location) return location;
  throw new CodexCompactionProtocolError(
    `Provider payload contained ${total} checkpoint markers; expected exactly one`,
  );
}

export function rewriteCheckpointMarker(payload: unknown, marker: string, replacementHistory: readonly JsonObject[]): JsonObject {
  if (!isObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("Codex payload is missing an input array");
  }
  const input: unknown[] = payload.input;
  const { index, item } = locateCheckpointMarker(input, marker);
  return {
    ...payload,
    input: [
      ...input.slice(0, index),
      ...replaceMarker(item, marker, replacementHistory),
      ...input.slice(index + 1),
    ],
  };
}

function appendCompactionTrigger(payload: CompactionPayload): CompactionPayload {
  if (payload.input.some((item) => item.type === "compaction_trigger")) {
    throw new CodexCompactionProtocolError("Provider payload already contains a compaction trigger");
  }
  return { ...payload, input: [...payload.input, { type: "compaction_trigger" }] };
}

/** Replay the checkpoint, let the caller adapt the history, then append the V2 trigger. */
export function prepareRemoteCompactionPayload(
  payload: CompactionPayload,
  checkpoint: { marker: string; replacementHistory: readonly JsonObject[]; onReplay?: (items: readonly JsonObject[]) => void } | undefined,
  adaptHistory: (history: CompactionPayload) => CompactionPayload,
): CompactionPayload {
  let history = payload;
  if (checkpoint) {
    const { input } = payload;
    const { index, item } = locateCheckpointMarker(input, checkpoint.marker);
    history = {
      ...payload,
      input: [
        ...input.slice(0, index),
        ...replaceMarker(item, checkpoint.marker, checkpoint.replacementHistory, checkpoint.onReplay),
        ...input.slice(index + 1),
      ],
    };
  }
  return appendCompactionTrigger(adaptHistory(history));
}

export function hasCheckpointMarker(payload: unknown, marker: string): boolean {
  return (
    isObject(payload) &&
    Array.isArray(payload.input) &&
    payload.input.some((item: unknown) => isObject(item) && markerCount(item, marker) > 0)
  );
}
