import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReplacementHistory, RETAINED_MESSAGE_TOKEN_BUDGET } from "./retention.js";
import type { JsonObject } from "./protocol.js";

const opaque = { type: "compaction", encrypted_content: "opaque" };
const user = (text: string): JsonObject => ({ role: "user", content: [{ type: "input_text", text }] });
function content(item: JsonObject): Array<{ type: string; text?: string }> {
  return item.content as Array<{ type: string; text?: string }>;
}

test("retains user history in order and appends only the new opaque item", () => {
  const input = [user("first"), { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    { type: "function_call_output", output: "tool result" }, { role: "developer", content: [] }, opaque, user("last")];
  assert.deepEqual(buildReplacementHistory(input, opaque), [input[0], input[5], opaque]);
});

test("matches Codex's boundary truncation with one token remaining", () => {
  const newest = user("x".repeat((RETAINED_MESSAGE_TOKEN_BUDGET - 1) * 4));
  const retained = buildReplacementHistory([user("excluded older input"), user("abcdefghij"), newest], opaque);
  assert.equal(retained.length, 3);
  assert.equal(content(retained[0])[0].text, "ab…2 tokens truncated…ij");
  assert.deepEqual(retained[1], newest);
});

test("charges UTF-8 bytes and keeps complete Unicode characters at both boundaries", () => {
  const text = `HEAD${"😀".repeat(RETAINED_MESSAGE_TOKEN_BUDGET)}TAIL`;
  const input = user(text);
  const retained = buildReplacementHistory([input], opaque);
  const truncated = content(retained[0])[0].text;
  assert.ok(truncated);
  assert.match(truncated, /^HEAD/);
  assert.match(truncated, /…2 tokens truncated…/);
  assert.match(truncated, /TAIL$/);
  assert.doesNotMatch(truncated, /\uFFFD/);
  assert.equal(content(input)[0].text, text);
});

test("rounds each text part separately and truncates content in its original order", () => {
  const newest = user("x".repeat((RETAINED_MESSAGE_TOKEN_BUDGET - 3) * 4));
  const boundary = { role: "user", content: [
    { type: "input_text", text: "aaaaa" }, { type: "input_text", text: "bbbbb" },
    { type: "input_image", image_url: "https://example.test/image" }, { type: "input_text", text: "discarded" },
  ] };
  const retained = buildReplacementHistory([boundary, newest], opaque);
  assert.deepEqual(retained[0].content, [
    { type: "input_text", text: "aaaaa" }, { type: "input_text", text: "bb…1 tokens truncated…bb" },
    boundary.content[2],
  ]);
});

test("preserves media on the metadata-free default path without an extra per-image cutoff", () => {
  const image = { type: "input_image", image_url: `data:image/png;base64,${"a".repeat(3 * 1024 * 1024)}` };
  const message = { role: "user", content: [image, { type: "input_audio", audio_url: "https://example.test/audio" }] };
  assert.deepEqual(buildReplacementHistory([message], opaque), [message, opaque]);
});

test("keeps a resize notice with its source and charges the notice text", () => {
  const notice = { role: "developer", content: [{ type: "input_text", text: "<image_resize_notice>resized</image_resize_notice>" }] };
  const source = user("x".repeat(RETAINED_MESSAGE_TOKEN_BUDGET * 4));
  const retained = buildReplacementHistory([source, notice], opaque);
  assert.equal(retained.length, 3);
  assert.deepEqual(retained[1], notice);
  assert.match(content(retained[0])[0].text ?? "", /tokens truncated/);
  assert.deepEqual(buildReplacementHistory([{ role: "assistant", content: [] }, notice], opaque), [opaque]);
});

test("charges at least one token for empty and media-only user messages", () => {
  const empty = { role: "user", content: [] };
  const input = Array.from({ length: RETAINED_MESSAGE_TOKEN_BUDGET + 1 }, () => empty);
  assert.equal(buildReplacementHistory(input, opaque).length, RETAINED_MESSAGE_TOKEN_BUDGET + 1);
});
