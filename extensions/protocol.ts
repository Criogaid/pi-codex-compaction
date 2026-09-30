// Own Responses V2 item validation and checkpoint payload transformations.
export const MAX_PROVIDER_EVENT_BYTES = 8 * 1024 * 1024;
export const MAX_COMPACTION_ITEM_BYTES = 2 * 1024 * 1024;
export const REMOTE_COMPACTION_PROTOCOL = "remote-compaction-v2" as const;

export type JsonObject = Record<string, unknown>;

export class CodexCompactionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCompactionProtocolError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInputImage(value: unknown): value is JsonObject {
  return isObject(value) && value.type === "input_image";
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
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_COMPACTION_ITEM_BYTES) {
    throw new CodexCompactionProtocolError("Remote compaction item exceeded the size limit");
  }
  return { ...structuredClone(value), type: "compaction" };
}

export interface CompactionCollector {
  observe(event: unknown): void;
  finish(): JsonObject;
}

/** Count output-item completion events, as Codex does; response.output is not another source. */
export function createCompactionCollector(): CompactionCollector {
  let bytes = 0;
  let count = 0;
  let item: JsonObject | undefined;
  let completed = false;
  return {
    observe(event) {
      if (!isObject(event)) return;
      bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
      if (bytes > MAX_PROVIDER_EVENT_BYTES) {
        throw new CodexCompactionProtocolError("Remote compaction stream exceeded the size limit");
      }
      // A provider may restart its response when falling back from WebSocket to HTTP.
      if (event.type === "response.created") {
        count = 0;
        item = undefined;
        completed = false;
      }
      if (event.type === "response.output_item.done" && isObject(event.item) &&
          isCompactionType(event.item.type)) {
        count += 1;
        item = validateCompactionItem(event.item);
      }
      if (event.type === "response.completed") completed = true;
    },
    finish() {
      if (!completed) {
        throw new CodexCompactionProtocolError(
          "Remote compaction stream ended without response.completed",
        );
      }
      if (count !== 1 || !item) {
        throw new CodexCompactionProtocolError(
          `Remote compaction returned ${count} compaction output events; expected exactly one`,
        );
      }
      return item;
    },
  };
}

function markerText(item: unknown): string | undefined {
  if (
    !isObject(item) ||
    item.role !== "user" ||
    !Array.isArray(item.content) ||
    item.content.length !== 1
  ) {
    return undefined;
  }
  const content = item.content[0];
  return isObject(content) &&
    content.type === "input_text" &&
    typeof content.text === "string"
    ? content.text
    : undefined;
}

export function rewriteCheckpointMarker(
  payload: unknown,
  marker: string,
  replacementHistory: readonly unknown[],
): JsonObject {
  if (!isObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("Codex payload is missing an input array");
  }
  const matches = payload.input
    .map((item, index) => (markerText(item) === marker ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new CodexCompactionProtocolError(
      `Provider payload contained ${matches.length} checkpoint markers; expected exactly one`,
    );
  }
  const index = matches[0];
  return {
    ...payload,
    input: [
      ...payload.input.slice(0, index),
      ...structuredClone(replacementHistory),
      ...payload.input.slice(index + 1),
    ],
  };
}

export function appendCompactionTrigger(payload: unknown): JsonObject {
  if (!isObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("Codex payload is missing an input array");
  }
  if (payload.input.some((item) => isObject(item) && item.type === "compaction_trigger")) {
    throw new CodexCompactionProtocolError("Provider payload already contains a compaction trigger");
  }
  return { ...payload, input: [...payload.input, { type: "compaction_trigger" }] };
}

export function prepareRemoteCompactionPayload(
  payload: unknown,
  checkpoint?: { marker: string; replacementHistory: readonly unknown[] },
): JsonObject {
  return appendCompactionTrigger(
    checkpoint
      ? rewriteCheckpointMarker(payload, checkpoint.marker, checkpoint.replacementHistory)
      : payload,
  );
}

export function hasCheckpointMarker(payload: unknown, marker: string): boolean {
  return (
    isObject(payload) &&
    Array.isArray(payload.input) &&
    payload.input.some((item) => markerText(item) === marker)
  );
}
