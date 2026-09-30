import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReplacementHistory, RETAINED_MESSAGE_TOKEN_BUDGET } from "./retention.js";
import type { JsonObject } from "./protocol.js";
import { imageTokenCounts } from "./image-budget.js";

async function retain(input: readonly JsonObject[]) {
  const images = await imageTokenCounts(input, new AbortController().signal);
  return buildReplacementHistory(input, opaque, images);
}

const opaque = { type: "compaction", encrypted_content: "opaque" };
const user = (text: string): JsonObject => ({ role: "user", content: [{ type: "input_text", text }] });
function content(item: JsonObject): Array<{ type: string; text?: string }> {
  return item.content as Array<{ type: string; text?: string }>;
}

test("retains user history in order and appends only the new opaque item", async () => {
  const input = [user("first"), { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    { type: "function_call_output", output: "tool result" }, { role: "developer", content: [] }, opaque, user("last")];
  assert.deepEqual(await retain(input), [input[0], input[5], opaque]);
});

test("matches Codex's boundary truncation with one token remaining", async () => {
  const newest = user("x".repeat((RETAINED_MESSAGE_TOKEN_BUDGET - 1) * 4));
  const retained = await retain([user("excluded older input"), user("abcdefghij"), newest]);
  assert.equal(retained.length, 3);
  assert.equal(content(retained[0])[0].text, "ab…2 tokens truncated…ij");
  assert.deepEqual(retained[1], newest);
});

test("charges UTF-8 bytes and keeps complete Unicode characters at both boundaries", async () => {
  const text = `HEAD${"😀".repeat(RETAINED_MESSAGE_TOKEN_BUDGET)}TAIL`;
  const input = user(text);
  const retained = await retain([input]);
  const truncated = content(retained[0])[0].text;
  assert.ok(truncated);
  assert.match(truncated, /^HEAD/);
  assert.match(truncated, /…2 tokens truncated…/);
  assert.match(truncated, /TAIL$/);
  assert.doesNotMatch(truncated, /\uFFFD/);
  assert.equal(content(input)[0].text, text);
});

test("rounds each text part separately and truncates content in its original order", async () => {
  const newest = user("x".repeat((RETAINED_MESSAGE_TOKEN_BUDGET - 3) * 4));
  const boundary = { role: "user", content: [
    { type: "input_text", text: "aaaaa" }, { type: "input_text", text: "bbbbb" },
    { type: "input_audio", audio_url: "https://example.test/audio" }, { type: "input_text", text: "discarded" },
  ] };
  const retained = await retain([boundary, newest]);
  assert.deepEqual(retained[0].content, [
    { type: "input_text", text: "aaaaa" }, { type: "input_text", text: "bb…1 tokens truncated…bb" },
    boundary.content[2],
  ]);
});

test("preserves fitting media without an extra per-image byte cutoff", async () => {
  const image = { type: "input_image", image_url: `data:image/png;base64,${"a".repeat(3 * 1024 * 1024)}` };
  const message = { role: "user", content: [image, { type: "input_audio", audio_url: "https://example.test/audio" }] };
  assert.deepEqual(await retain([message]), [message, opaque]);
});

test("keeps a resize notice with its source and charges the notice text", async () => {
  const notice = { role: "developer", content: [{ type: "input_text", text: "<image_resize_notice>resized</image_resize_notice>" }] };
  const source = user("x".repeat(RETAINED_MESSAGE_TOKEN_BUDGET * 4));
  const retained = await retain([source, notice]);
  assert.equal(retained.length, 3);
  assert.deepEqual(retained[1], notice);
  assert.match(content(retained[0])[0].text ?? "", /tokens truncated/);
  assert.deepEqual(await retain([{ role: "assistant", content: [] }, notice]), [opaque]);
});

test("charges at least one token for empty user messages", async () => {
  const empty = { role: "user", content: [] };
  const input = Array.from({ length: RETAINED_MESSAGE_TOKEN_BUDGET + 1 }, () => empty);
  assert.equal((await retain(input)).length, RETAINED_MESSAGE_TOKEN_BUDGET + 1);
});

test("does not backfill older messages when a boundary image cannot fit", async () => {
  const image = { type: "input_image", file_id: "large", detail: "original" };
  const newest = user("x".repeat((RETAINED_MESSAGE_TOKEN_BUDGET - 1) * 4));
  assert.deepEqual(await retain([user("must not backfill"), { role: "user", content: [image] }, newest]), [newest, opaque]);
});

test("drops an image and its labels atomically when only the image would fit", async () => {
  const image = { type: "input_image", file_id: "original", detail: "original" };
  const newest = user("x".repeat((RETAINED_MESSAGE_TOKEN_BUDGET - 10_000) * 4));
  const boundary = { role: "user", content: [
    { type: "input_text", text: '<image name="[Image #1]">' }, image, { type: "input_text", text: "</image>" },
  ] };
  assert.deepEqual(await retain([boundary, newest]), [newest, opaque]);
});

test("retains later image groups and nearby text in an image-containing boundary", async () => {
  const original = { type: "input_image", file_id: "large", detail: "original" };
  const later = { type: "input_image", image_url: "https://example.test/later" };
  const boundary = { role: "user", content: [
    { type: "input_text", text: "earliest" }, { type: "input_text", text: "<image>" }, original,
    { type: "input_text", text: "</image>" }, { type: "input_text", text: "mid" },
    { type: "input_text", text: "<image>" }, later, { type: "input_text", text: "</image>" },
    { type: "input_text", text: "end" },
  ] };
  const newest = user("x".repeat((RETAINED_MESSAGE_TOKEN_BUDGET - 2_000) * 4));
  const retained = await retain([user("older"), boundary, newest]);
  assert.deepEqual(retained[0].content, boundary.content.slice(4));
  assert.deepEqual(retained.slice(1), [newest, opaque]);
});

test("charges ordinary images and preserves the newest 34 in an oversized image-only message", async () => {
  const images = Array.from({ length: 35 }, (_, index) => ({ type: "input_image", image_url: `https://example.test/${index}` }));
  const retained = await retain([user("older"), { role: "user", content: images }]);
  assert.deepEqual(retained, [{ role: "user", content: images.slice(1) }, opaque]);
});

test("recognizes resize notices with the upstream ASCII case-insensitive markers", async () => {
  const notice = { role: "developer", content: [{ type: "input_text", text: "\n<IMAGE_RESIZE_NOTICE>x</IMAGE_RESIZE_NOTICE>\n" }] };
  const source = user("source");
  assert.deepEqual(await retain([source, notice]), [source, notice, opaque]);
});
