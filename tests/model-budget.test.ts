import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { itemTokenCount } from "../src/context-window.js";
import { RESIZED_IMAGE_BYTES_ESTIMATE, type ImageEstimates } from "../src/image-budget.js";
import { estimateModelInput, modelInputBudget } from "../src/model-budget.js";
import type { JsonObject } from "../src/protocol.js";
import { approximateTokenCount, approximateTokensFromBytes } from "../src/text-budget.js";

const images: ImageEstimates = { bytes: () => 4_000 };
const model = { contextWindow: 100_000, maxTokens: 10_000 } as Model<Api>;

test("reserves the larger output allowance from the floored 95 percent physical window", () => {
  assert.equal(modelInputBudget(model), 85_000);
  assert.equal(modelInputBudget(model, 5_000), 85_000);
  assert.equal(modelInputBudget(model, 20_000), 75_000);
  assert.equal(modelInputBudget({ ...model, contextWindow: 101, maxTokens: 10 }), 85);
  assert.equal(modelInputBudget(model, 100_000), 0);
  assert.equal(modelInputBudget({ ...model, maxTokens: 100_000 }), 0);
});

test("invalid windows or output reserves never create a usable or NaN budget", () => {
  for (const contextWindow of [0, -1, NaN, Infinity, -Infinity, 100.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(modelInputBudget({ ...model, contextWindow }), 0);
  }
  for (const reserve of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(modelInputBudget({ ...model, maxTokens: reserve }), 0);
    assert.equal(modelInputBudget(model, reserve), 0);
  }
  assert.equal(modelInputBudget({ ...model, maxTokens: 0 }), 95_000);
});

test("counts the entire plaintext payload, including instructions, schemas, and unfamiliar fields", () => {
  const payload: JsonObject = {
    model: "gpt-fixture",
    instructions: "é中😀",
    tools: [{ type: "function", name: "run", parameters: { type: "object", properties: { task: { type: "string" } } } }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "Request" }] },
      { role: "assistant", content: [{ type: "output_text", text: "Response" }] },
      { type: "function_call", call_id: "call", name: "run", arguments: '{"task":"work"}' },
      { type: "custom_tool_call", call_id: "custom", name: "grammar", input: "program" },
      { type: "function_call_output", call_id: "call", output: "result" },
      { type: "additional_tools", tools: [{ type: "function", name: "extra", parameters: {} }] },
      { type: "tool_search_output", call_id: "search", tools: [{ type: "function", name: "found" }] },
      { type: "tool_search_call", arguments: { query: "query" } },
      { type: "web_search_call", action: { query: "web" } },
      { type: "future_item", payload: { nested: [{ text: "unfamiliar" }] } },
    ],
    future_field: { nested: ["unknown"] },
  };
  assert.equal(estimateModelInput(payload, images), approximateTokenCount(JSON.stringify(payload)));
  for (const field of ["instructions", "tools", "input", "future_field"]) {
    const without = { ...payload };
    delete without[field];
    assert.ok(estimateModelInput(payload, images) > estimateModelInput(without, images), field);
  }
  const growing = { ...payload, future_field: { nested: ["unknown" + "x".repeat(4_000)] } };
  assert.equal(estimateModelInput(growing, images) - estimateModelInput(payload, images), 1_000);
});

for (const type of ["reasoning", "compaction", "compaction_summary", "context_compaction"]) {
  test(`counts ${type} semantically while retaining its envelope and unknown fields`, () => {
    const item = { type, encrypted_content: "opaque".repeat(2_000), id: "checkpoint", summary: [{ text: "visible summary" }] };
    const payload = { instructions: "prompt", input: [item] };
    const envelope = { ...payload, input: [{ ...item, encrypted_content: "" }] };
    const estimated = estimateModelInput(payload, images);
    assert.equal(estimated, itemTokenCount(item, images) + approximateTokenCount(JSON.stringify(envelope)));
    assert.ok(estimated < approximateTokenCount(JSON.stringify(payload)), "does not charge ciphertext as plaintext");
    assert.equal(estimateModelInput({ ...payload, input: [{ ...item, extra: "x".repeat(4_000) }] }, images) -
      estimateModelInput({ ...payload, input: [{ ...item, extra: "" }] }, images), 1_000);
  });
}

for (const type of ["message", "function_call_output", "custom_tool_call_output"]) {
  test(`counts inline images in ${type} without charging their data URLs as text`, () => {
    const part = { type: "input_image", image_url: "data:image/png;base64," + "x".repeat(100_000), detail: "original" };
    const parts = [{ type: "input_text", text: "description" }, part];
    const item = type === "message" ? { type, role: "user", content: parts } : { type, call_id: "call", output: parts };
    const payload = { instructions: "prompt", input: [item] };
    const saved = structuredClone(payload);
    const empty = type === "message"
      ? { ...item, content: [parts[0], { ...part, image_url: "" }] }
      : { ...item, output: [parts[0], { ...part, image_url: "" }] };
    assert.equal(estimateModelInput(payload, images),
      approximateTokenCount(JSON.stringify({ ...payload, input: [empty] })) + 1_000);
    assert.deepEqual(payload, saved, "estimating does not rewrite saved history");
  });
}

test("counts file images and encrypted content parts in addition to visible JSON", () => {
  const encrypted = { type: "encrypted_content", encrypted_content: "ciphertext".repeat(1_000) };
  const file = { type: "input_image", file_id: "file-id", detail: "original" };
  const payload = { input: [{ role: "user", content: [encrypted, file] }] };
  const envelope = { input: [{ role: "user", content: [{ ...encrypted, encrypted_content: "" }, file] }] };
  assert.equal(estimateModelInput(payload, images), approximateTokenCount(JSON.stringify(envelope)) +
    itemTokenCount({ content: [encrypted] }, images) + 1_000);
});

test("generated images use the semantic image allowance while the revised prompt stays visible", () => {
  const item = { type: "image_generation_call", revised_prompt: "Draw a tree", result: "binary".repeat(100_000) };
  const payload = { input: [item] };
  const envelope = { input: [{ ...item, result: "" }] };
  assert.equal(estimateModelInput(payload, images), approximateTokenCount(JSON.stringify(envelope)) +
    approximateTokensFromBytes(RESIZED_IMAGE_BYTES_ESTIMATE));
});

test("unknown image-like values keep their full JSON cost instead of disappearing", () => {
  const payload = { input: [{ type: "future_item", nested: { type: "input_image", image_url: "data".repeat(1_000) } }] };
  assert.equal(estimateModelInput(payload, images), approximateTokenCount(JSON.stringify(payload)));
  assert.equal(estimateModelInput({ input: "text input" }, images), approximateTokenCount(JSON.stringify({ input: "text input" })));
});

test("unestimable payloads saturate closed with a finite number", () => {
  const circular: JsonObject = {};
  circular.self = circular;
  for (const payload of [circular, { future_field: 1n }]) {
    assert.equal(estimateModelInput(payload, images), Number.MAX_SAFE_INTEGER);
  }
  const payload = { input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,eA==" }] }] };
  for (const bytes of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(estimateModelInput(payload, { bytes: () => bytes }), Number.MAX_SAFE_INTEGER);
  }
  assert.equal(estimateModelInput(payload, { bytes: () => { throw new Error("Missing image probe"); } }), Number.MAX_SAFE_INTEGER);
  assert.equal(estimateModelInput({}, images), approximateTokenCount("{}"));
});
