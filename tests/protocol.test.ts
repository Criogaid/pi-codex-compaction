import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_API, CodexCompactionProtocolError, createCompactionCollector, isObject, normalizeCompactionEvent, prepareRemoteCompactionPayload, rewriteCheckpointMarker, withoutInputImages } from "../src/protocol.js";

const item = { type: "compaction", encrypted_content: "opaque" };
const done = { type: "response.output_item.done", item };
const completed = { type: "response.completed", response: { output: [item] } };
const duplicateOutputError = {
  name: CodexCompactionProtocolError.name,
  message: "Remote compaction returned duplicate compaction output events",
};

test("counts one completed output item without counting response.output twice", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  collector.observe(completed);
  assert.deepEqual(collector.finish(), item);
});

test("rejects a compaction output item that arrives after response.completed", () => {
  const collector = createCompactionCollector();
  collector.observe({ type: "response.created" });

  assert.throws(() => {
    collector.observe(completed);
    collector.observe(done);
    collector.finish();
  }, CodexCompactionProtocolError);
});

test("normalizes a successful Codex response.done alias before collection", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  collector.observe(normalizeCompactionEvent(CODEX_API, {
    type: "response.done", response: { status: "completed", output: [item] },
  }));
  assert.deepEqual(collector.finish(), item);
});

test("keeps a content-filtered Codex response.done event raw", () => {
  const event = {
    type: "response.done",
    response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
  };
  const expected = structuredClone(event);
  assert.deepEqual(normalizeCompactionEvent(CODEX_API, event), expected);
});

test("standard Responses keeps collecting after response.done", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  collector.observe(normalizeCompactionEvent("openai-responses", {
    type: "response.done", response: { status: "completed", output: [item] },
  }));
  assert.equal(collector.completed, false);
  collector.observe(completed);
  assert.deepEqual(collector.finish(), item);
});

for (const status of ["incomplete", "failed", "cancelled", "in_progress"]) {
  test(`rejects a stream ending with Codex response.done status ${status}`, () => {
    const collector = createCompactionCollector();
    collector.observe(done);
    collector.observe(normalizeCompactionEvent(CODEX_API, { type: "response.done", response: { status } }));
    assert.throws(() => collector.finish(), CodexCompactionProtocolError);
  });

  test(`rejects response.completed with unsuccessful status ${status}`, () => {
    const collector = createCompactionCollector();
    collector.observe(done);
    assert.throws(() => collector.observe({ type: "response.completed", response: { status } }),
      CodexCompactionProtocolError);
  });
}

test("rejects a stream ending with a bare Codex response.done", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  collector.observe(normalizeCompactionEvent(CODEX_API, { type: "response.done" }));
  assert.throws(() => collector.finish(), CodexCompactionProtocolError);
});

test("rejects unsuccessful terminal events without a response body", () => {
  for (const type of ["response.failed", "response.incomplete"]) {
    const collector = createCompactionCollector();
    collector.observe(done);
    assert.throws(() => collector.observe({ type }), CodexCompactionProtocolError);
  }
});

test("blocks replayed user and tool-output images without changing saved history or opaque items", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,private-image" };
  const text = { type: "input_text", text: "Keep this constraint" };
  const parts = [image, image, text, image];
  const history = [
    { role: "user", content: parts, id: "user" },
    { type: "function_call_output", call_id: "call", output: parts },
    { type: "custom_tool_call_output", call_id: "custom", output: parts },
    { type: "function_call", arguments: JSON.stringify({ image_url: "unrelated argument" }) },
    item,
  ];
  const saved = structuredClone(history);
  const filtered = withoutInputImages(history);
  const placeholder = { type: "input_text", text: "Image reading is disabled." };
  assert.deepEqual(filtered[0].content, [placeholder, text, placeholder]);
  assert.deepEqual(filtered[1].output, [placeholder, text, placeholder]);
  assert.deepEqual(filtered[2].output, [placeholder, text, placeholder]);
  assert.deepEqual(filtered.slice(3), history.slice(3));
  assert.doesNotMatch(JSON.stringify(filtered), /private-image/);
  assert.deepEqual(history, saved);
});

test("preparing V2 preserves tool declarations and loading history before the trigger", () => {
  const schema = { type: "function", name: "internal_read", description: "private-schema", parameters: { type: "object" } };
  const history = [
    { role: "developer", content: "Keep the task constraints" },
    { type: "additional_tools", role: "developer", tools: [schema] },
    { type: "tool_search_call", execution: "client", call_id: "pi_tool_load_fixture", arguments: { query: "internal_read" } },
    { type: "tool_search_output", execution: "client", call_id: "pi_tool_load_fixture", tools: [schema] },
    { type: "tool_search_call", execution: "client", call_id: "real_search", arguments: { query: "files" } },
    { type: "tool_search_output", execution: "client", call_id: "real_search", tools: [schema], status: "completed" },
    { type: "function_call", name: "internal_read", call_id: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "read", output: "important result" },
    { type: "custom_tool_call", name: "custom", call_id: "custom", input: "important input" },
    { type: "custom_tool_call_output", call_id: "custom", output: "custom result" },
    item,
  ];
  const payload = { model: "gpt", input: history, tools: [schema], tool_choice: { type: "function", name: "internal_read" },
    reasoning: { effort: "high" }, prompt_cache_key: "same-session" };
  const saved = structuredClone(payload);
  const prepared = prepareRemoteCompactionPayload(payload, undefined, (history) => history);
  assert.deepEqual(prepared, { ...payload, input: [...history, { type: "compaction_trigger" }] });
  assert.deepEqual(payload, saved);
});

test("rejects identical duplicate output events as Codex does", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  assert.throws(() => collector.observe(done), duplicateOutputError);
});

test("requires output_item.done and response.completed", () => {
  const missingItem = createCompactionCollector();
  assert.throws(() => missingItem.observe(completed), CodexCompactionProtocolError);
  const incomplete = createCompactionCollector();
  incomplete.observe(done);
  assert.throws(() => incomplete.finish(), CodexCompactionProtocolError);
});

test("accepts the compaction_summary alias", () => {
  const collector = createCompactionCollector();
  const alias = { ...item, type: "compaction_summary" };
  collector.observe({ ...done, item: alias });
  collector.observe({ ...completed, response: { output: [alias] } });
  assert.deepEqual(collector.finish(), item);
});

test("retains the compaction item when response.created arrives before completion", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  collector.observe({ type: "response.created" });
  collector.observe({ ...completed, response: { output: [] } });
  assert.deepEqual(collector.finish(), item);
});

test("rejects duplicate compaction items across response.created", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  collector.observe({ type: "response.created" });
  assert.throws(() => collector.observe({ ...done, item: { type: "compaction_summary" } }), duplicateOutputError);
});

test("accepts opaque output and event volume above the former plugin-only byte ceilings", () => {
  const collector = createCompactionCollector();
  const large = { ...item, encrypted_content: "x".repeat(3 * 1024 * 1024) };
  collector.observe({ type: "response.output_item.added", item: large });
  collector.observe({ type: "response.output_item.done", item: large });
  collector.observe({ type: "response.completed", response: { output: [large] } });
  assert.deepEqual(collector.finish(), large);
});

test("replays one marker and appends one final trigger", () => {
  const marker = "checkpoint";
  const payload = { model: "gpt", input: [
    { role: "user", content: [{ type: "input_text", text: marker }] },
    { role: "user", content: [{ type: "input_text", text: "later" }] },
  ] };
  const replacement = [{ type: "compaction", encrypted_content: "prior" }];
  const prepared = prepareRemoteCompactionPayload(payload, { marker, replacementHistory: replacement }, (history) => history);
  assert.deepEqual(prepared.input, [replacement[0], payload.input[1], { type: "compaction_trigger" }]);
  assert.equal(payload.input.length, 2);
  assert.throws(() => rewriteCheckpointMarker({ input: [] }, marker, replacement), CodexCompactionProtocolError);
  assert.throws(() => prepareRemoteCompactionPayload({ input: [{ type: "compaction_trigger" }] }, undefined, (history) => history), (error) => {
    assert.ok(error instanceof CodexCompactionProtocolError);
    assert.equal(error.message, "Provider payload already contains a compaction trigger");
    return true;
  });
});

test("replaces only the marker when request hooks tag or join the marker item", () => {
  const marker = "[PI_CODEX_REMOTE_CHECKPOINT:id] marker";
  const replacement = [{ type: "compaction", encrypted_content: "prior" }];
  const image = { type: "input_image", image_url: "data:image/png;base64,AA==" };
  const tagged = rewriteCheckpointMarker({ input: [
    { role: "user", content: [{ type: "input_text", text: `[tagged] ${marker}` }] },
  ] }, marker, replacement);
  assert.deepEqual(tagged.input, [{ role: "user", content: [{ type: "input_text", text: "[tagged] " }] }, ...replacement]);
  const joined = rewriteCheckpointMarker({ input: [
    { role: "user", content: [image, { type: "input_text", text: `${marker}\n\nlater` }, image] },
  ] }, marker, replacement);
  assert.deepEqual(joined.input, [
    { role: "user", content: [image] },
    ...replacement,
    { role: "user", content: [{ type: "input_text", text: "\n\nlater" }, image] },
  ]);
  assert.throws(() => rewriteCheckpointMarker({ input: [
    { role: "user", content: [{ type: "input_text", text: `${marker} ${marker}` }] },
  ] }, marker, replacement), CodexCompactionProtocolError);
  assert.throws(() => rewriteCheckpointMarker({ input: [
    { role: "assistant", content: [{ type: "input_text", text: marker }] },
  ] }, marker, replacement), CodexCompactionProtocolError);
});

test("recognizes non-null objects while rejecting arrays and primitives", () => {
  for (const value of [undefined, null, [], ["item"], "text", 1, false, () => ({})]) {
    assert.equal(isObject(value), false);
  }
  assert.equal(isObject({}), true);
  assert.equal(isObject({ input: [] }), true);
});

test("adapts expanded checkpoint history before appending the final trigger", () => {
  const replacement = [{ type: "compaction", encrypted_content: "prior" }];
  const later = { role: "user", content: [{ type: "input_text", text: "later" }] };
  const payload = { model: "gpt", instructions: "original", input: [
    { role: "user", content: [{ type: "input_text", text: "marker" }] }, later,
  ] };
  const saved = structuredClone(payload);
  let adaptations = 0;
  const prepared = prepareRemoteCompactionPayload(payload, { marker: "marker", replacementHistory: replacement }, (history) => {
    adaptations++;
    assert.deepEqual(history.input, [...replacement, later]);
    assert.equal(history.instructions, "original");
    return { ...history, instructions: "adapted", input: [later] };
  });
  assert.equal(adaptations, 1);
  assert.deepEqual(prepared, { model: "gpt", instructions: "adapted", input: [later, { type: "compaction_trigger" }] });
  assert.deepEqual(payload, saved);
  assert.deepEqual(replacement, [{ type: "compaction", encrypted_content: "prior" }]);
});

test("adapts history without a checkpoint and validates the resulting trigger sequence", () => {
  const payload = { model: "gpt", input: [] };
  let adaptations = 0;
  assert.deepEqual(prepareRemoteCompactionPayload(payload, undefined, (history) => {
    adaptations++;
    assert.deepEqual(history, payload);
    return { ...history, instructions: "adapted" };
  }), { ...payload, instructions: "adapted", input: [{ type: "compaction_trigger" }] });
  assert.equal(adaptations, 1);
  assert.throws(() => prepareRemoteCompactionPayload(payload, undefined, () => ({ input: [{ type: "compaction_trigger" }] })), CodexCompactionProtocolError);
});

test("skips adaptation after failed marker substitutions and propagates adaptation errors", () => {
  const adapt = () => assert.fail("failed marker substitution must not reach the adapter");
  assert.throws(() => prepareRemoteCompactionPayload({ input: [] }, { marker: "missing", replacementHistory: [] }, adapt), CodexCompactionProtocolError);
  const reason = new Error("adaptation failed");
  assert.throws(() => prepareRemoteCompactionPayload({ input: [] }, undefined, () => { throw reason; }), (error) => error === reason);
});
