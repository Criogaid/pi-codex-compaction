import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReplacementHistory, RETAINED_MESSAGE_TOKEN_BUDGET } from "./retention.js";
import type { JsonObject } from "./protocol.js";
import { prepareRetention } from "./retention-input.js";

async function retain(input: readonly JsonObject[]) {
  return buildReplacementHistory(await prepareRetention(input, new AbortController().signal), opaque);
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

test("excludes official contextual user fragments and their attached resize notices", async () => {
  const hidden = [
    "# AGENTS.md instructions for /project\n<INSTRUCTIONS>rules</INSTRUCTIONS>",
    "<ENVIRONMENT_CONTEXT>state</ENVIRONMENT_CONTEXT>",
    "<agent_message_board_notification>x</agent_message_board_notification>",
    "<skill>instructions</skill>", "<user_shell_command>ls</user_shell_command>",
    "<turn_aborted>stopped</turn_aborted>", "<subagent_notification>x</subagent_notification>",
    "<recommended_plugins>x</recommended_plugins>", "<external_test>data</external_test>",
    '<codex_internal_context source="goal_1">steering</codex_internal_context>',
    "<goal_context>legacy</goal_context>",
    "Warning: apply_patch was requested via bash. Use the apply_patch tool instead of exec_command.",
    "Warning: The maximum number of unified exec processes you can keep open is 64",
    "Warning: Your account was flagged for potentially high-risk cyber activity.",
  ];
  const notice = { role: "developer", content: [{ type: "input_text", text: "<image_resize_notice>x</image_resize_notice>" }] };
  for (const text of hidden) {
    const message = user(`\u0085 ${text}\u0085`);
    assert.deepEqual(await retain([user("request"), message, notice]), [user("request"), opaque], text);
    assert.deepEqual(await retain([{ ...message, content: [...content(message), { type: "input_text", text: "ordinary" }] }]), [opaque], text);
  }
});

test("keeps ordinary lookalikes and matches the upstream marker case rules", async () => {
  for (const text of ["<skill>not closed", "<EXTERNAL_test>x</EXTERNAL_test>",
    '<codex_internal_context source="INVALID">x</codex_internal_context>',
    "\uFEFF<skill>x</skill>", "<user_instructions>request</user_instructions>"]) {
    assert.deepEqual(await retain([user(text)]), [user(text), opaque]);
  }
});

test("matches hook XML results checked against the actual upstream quick-xml parser", async () => {
  const context = { type: "input_text", text: "<skill>instructions</skill>" };
  const fixtures: readonly (readonly [string, boolean])[] = [
    ['<hook_prompt hook_run_id="r">text</hook_prompt>', true],
    ['<other hook_run_id="r">text</other>', true],
    ['<hook_prompt hook_run_id="r"/>', false],
    ['<hook_prompt hook_run_id="r"> </hook_prompt>', false],
    ['<hook_prompt hook_run_id="r"><![CDATA[x]]></hook_prompt>', true],
    ['<hook_prompt hook_run_id="r"><child>x</child></hook_prompt>', false],
    ['<hook_prompt hook_run_id="r">a<child>x</child>b</hook_prompt>', false],
    ['<hook_prompt hook_run_id="r">a<!-- comment -->b</hook_prompt>', true],
    ['<hook_prompt hook_run_id="r">a</hook_prompt><other/>', true],
    ['<hook_prompt hook_run_id=" ">a</hook_prompt>', false],
    ['<hook_prompt hook_run_id="r">&amp;</hook_prompt>', true],
    ['<hook_prompt hook_run_id="r">a</broken>', false],
    ['<hook_prompt hook_run_id="r">a', false],
  ];
  for (const [text, visible] of fixtures) {
    const message = { role: "user", content: [context, { type: "input_text", text }] };
    assert.deepEqual(await retain([message]), visible ? [message, opaque] : [opaque], text);
  }
  const hook = { type: "input_text", text: fixtures[0][0] };
  assert.deepEqual(await retain([{ role: "user", content: [hook, { type: "input_text", text: "ordinary" }] }]), [opaque]);
  assert.deepEqual(await retain([{ role: "user", content: [hook, { type: "input_image", file_id: "image" }] }]), [opaque]);
});

test("rounds image bytes upward to tokens at the retention boundary", async () => {
  const image = { type: "input_image", image_url: "already estimated" };
  const boundary = { role: "user", content: [image] };
  for (const [bytes, tokens] of [[4, 1], [5, 2], [7_373, 1_844]]) {
    for (const available of [tokens - 1, tokens]) {
      const newest = user("x".repeat((RETAINED_MESSAGE_TOKEN_BUDGET - available) * 4));
      const prepared = await prepareRetention([boundary, newest], new AbortController().signal, { images: { bytes: () => bytes } });
      assert.deepEqual(buildReplacementHistory(prepared, opaque), available === tokens ? [boundary, newest, opaque] : [newest, opaque]);
    }
  }
});

test("clones and appends compaction items without validating or normalizing them", async () => {
  const source = user("retained");
  const prepared = await prepareRetention([source], new AbortController().signal);
  for (const item of [
    { type: "compaction_summary", encrypted_content: "opaque", metadata: { tag: "preserve" } },
    { type: "compaction", encrypted_content: "", metadata: { tag: "validation belongs upstream" } },
  ]) {
    const result = buildReplacementHistory(prepared, item);
    assert.deepEqual(result, [source, item]);
    assert.notEqual(result[0], source);
    assert.notEqual(result[0].content, source.content);
    assert.notEqual(result[1], item);
    assert.notEqual(result[1].metadata, item.metadata);
  }
});
