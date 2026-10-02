import assert from "node:assert/strict";
import { test } from "node:test";
import { itemTokenCount, trimToolOutputsToContextWindow } from "../src/context-window.js";
import type { ImageEstimates } from "../src/image-budget.js";
import type { JsonObject } from "../src/protocol.js";

const images: ImageEstimates = { bytes: () => 7_373 };
const truncated = "Output exceeded the available model context and was truncated";
const notice = { role: "developer", content: [{ type: "input_text", text: "<image_resize_notice></image_resize_notice>" }] };

const itemCases: readonly [string, JsonObject, number][] = [
  ["implicit message", { role: "user", content: "é中😀" }, 3],
  ["parts rounded together", { type: "message", content: [{ type: "input_text", text: "a" }, { type: "output_text", text: "b" }] }, 1],
  ["empty content", { type: "message", content: [] }, 0],
  ["ignored parts", { type: "message", content: [null, "text", { type: "unknown", text: "ignored" }] }, 0],
  ["image plus text before rounding", { content: [{ type: "input_image" }, { type: "input_text", text: "abc" }] }, 1_844],
  ["encrypted part rounding", { content: [{ type: "encrypted_content", encrypted_content: "a".repeat(8) }] }, 2],
  ["encrypted UTF-8 part", { content: [{ type: "encrypted_content", encrypted_content: "😀😀" }] }, 2],
  ["default function namespace", { type: "function_call", name: "f", arguments: "{}" }, 3],
  ["explicit function namespace", { type: "function_call", name: "f", namespace: "x", arguments: "{}" }, 1],
  ["empty function namespace", { type: "function_call", name: "f", namespace: "", arguments: "{}" }, 1],
  ["custom tool input", { type: "custom_tool_call", name: "f", input: "{}" }, 3],
  ["function output metadata", { type: "function_call_output", output: "x", call_id: "c", name: "n", namespace: "ns" }, 2],
  ["custom output metadata", { type: "custom_tool_call_output", output: "x", call_id: "c", name: "n", namespace: "ignored" }, 1],
  ["function output image array", { type: "function_call_output", output: [{ type: "input_image" }, { type: "input_text", text: "abc" }] }, 1_844],
  ["custom output image array", { type: "custom_tool_call_output", output: [{ type: "input_image" }] }, 1_844],
  ["additional tools JSON", { type: "additional_tools", tools: ["é"] }, 2],
  ["tool search output JSON", { type: "tool_search_output", tools: ["é"] }, 2],
  ["tool search arguments JSON", { type: "tool_search_call", arguments: { q: "é" } }, 3],
  ["missing tools", { type: "additional_tools" }, 0],
  ["null tools", { type: "tool_search_output", tools: null }, 0],
  ["shell action JSON", { type: "local_shell_call", action: { q: "é" } }, 3],
  ["web action JSON", { type: "web_search_call", action: { q: "é" } }, 3],
  ["generated image", { type: "image_generation_call", revised_prompt: "abc", result: "encoded" }, 1_844],
  ["empty generated image", { type: "image_generation_call", revised_prompt: "abc", result: "" }, 1],
  ["unknown item", { type: "unknown", content: "ignored" }, 0],
];
for (const [name, item, tokens] of itemCases) {
  test(`estimates ${name}`, () => assert.equal(itemTokenCount(item, images), tokens));
}

for (const type of ["reasoning", "compaction", "compaction_summary", "context_compaction"]) {
  test(`estimates ${type} after removing the encrypted envelope`, () => {
    for (const [encrypted_content, tokens] of [["", 0], ["a".repeat(866), 0], ["a".repeat(868), 1], ["a".repeat(872), 1], ["a".repeat(874), 2], ["😀".repeat(218), 1]] as const) {
      assert.equal(itemTokenCount({ type, encrypted_content }, images), tokens);
    }
  });
}

test("trims only above the floored 95 percent window including instructions", () => {
  const output = { type: "function_call_output", output: "x".repeat(72) };
  assert.deepEqual(trimToolOutputsToContextWindow([output], "a", 20, images), [output]);
  assert.deepEqual(trimToolOutputsToContextWindow([output], "abcde", 20, images), [{ ...output, output: truncated }]);
  assert.deepEqual(trimToolOutputsToContextWindow([output], "a", 19, images), [{ ...output, output: truncated }]);
  assert.deepEqual(trimToolOutputsToContextWindow([output], { ignored: "x".repeat(100) }, 20, images), [output]);
});

test("rounds a source and its resize notice separately and removes the notice when trimming", () => {
  const output = { type: "function_call_output", output: "x".repeat(61) };
  // 61 source bytes and 43 notice bytes occupy 16 + 11 tokens, not 26.
  assert.equal(Buffer.byteLength(notice.content[0].text), 43);
  assert.deepEqual(trimToolOutputsToContextWindow([output, notice], "", 29, images), [output, notice]);
  assert.deepEqual(trimToolOutputsToContextWindow([output, notice], "", 28, images), [{ ...output, output: truncated }]);
});

test("rewrites newest outputs first and stops once the history fits", () => {
  const first = { type: "function_call_output", call_id: "a", output: "x".repeat(400) };
  const last = { type: "custom_tool_call_output", call_id: "b", output: "y".repeat(400) };
  const input = [first, notice, last, notice];
  const saved = structuredClone(input);
  assert.deepEqual(trimToolOutputsToContextWindow(input, "", 150, images), [first, notice, { ...last, output: truncated }]);
  assert.deepEqual(trimToolOutputsToContextWindow(input, "", 40, images), [{ ...first, output: truncated }, { ...last, output: truncated }]);
  assert.deepEqual(input, saved);
});

test("empties trailing search tools while preserving output metadata", () => {
  const output = { type: "tool_search_output", call_id: "search", status: "completed", tools: [{ description: "x".repeat(400) }] };
  assert.deepEqual(trimToolOutputsToContextWindow([output, notice], "", 20, images), [{ ...output, tools: [] }]);
});

test("stops at every non-output item even if earlier outputs still overflow", () => {
  const output = { type: "function_call_output", output: "x".repeat(400) };
  for (const barrier of [
    { role: "user", content: "barrier" }, { role: "assistant", content: "barrier" },
    { type: "function_call", name: "f", arguments: "{}" },
    { type: "tool_search_call", arguments: {} }, { type: "compaction", encrypted_content: "opaque" },
  ]) {
    assert.deepEqual(trimToolOutputsToContextWindow([output, barrier], "", 1, images), [output, barrier]);
    assert.deepEqual(trimToolOutputsToContextWindow([output, barrier, output, notice], "", 1, images), [output, barrier, { ...output, output: truncated }]);
  }
});

test("leaves disabled and nonfinite context windows unchanged without mutating input", () => {
  const input = [{ type: "function_call_output", output: "x".repeat(400) }, notice];
  for (const window of [0, -1, Infinity, -Infinity, NaN]) {
    const result = trimToolOutputsToContextWindow(input, "instructions", window, images);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
  }
  assert.deepEqual(trimToolOutputsToContextWindow([], "x".repeat(400), 1, images), []);
});
