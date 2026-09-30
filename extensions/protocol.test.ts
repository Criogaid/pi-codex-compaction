import assert from "node:assert/strict";
import { test } from "node:test";
import { appendCompactionTrigger, createCompactionCollector, prepareRemoteCompactionPayload, rewriteCheckpointMarker } from "./protocol.js";

const item = { type: "compaction", encrypted_content: "opaque" };
const done = { type: "response.output_item.done", item };
const completed = { type: "response.completed", response: { output: [item] } };

test("counts one completed output item without counting response.output twice", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  collector.observe(completed);
  assert.deepEqual(collector.finish(), item);
});

test("rejects identical duplicate output events as Codex does", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  collector.observe(done);
  collector.observe(completed);
  assert.throws(() => collector.finish(), /2 compaction output events/);
});

test("requires output_item.done and response.completed", () => {
  const missingItem = createCompactionCollector();
  missingItem.observe(completed);
  assert.throws(() => missingItem.finish(), /0 compaction output events/);
  const incomplete = createCompactionCollector();
  incomplete.observe(done);
  assert.throws(() => incomplete.finish(), /without response.completed/);
});

test("accepts the upstream compaction_summary alias and resets on a retried response", () => {
  const collector = createCompactionCollector();
  collector.observe(done);
  collector.observe({ type: "response.created" });
  const alias = { ...item, type: "compaction_summary" };
  collector.observe({ ...done, item: alias });
  collector.observe(completed);
  assert.deepEqual(collector.finish(), item);
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
  const prepared = prepareRemoteCompactionPayload(payload, { marker, replacementHistory: replacement });
  assert.deepEqual(prepared.input, [replacement[0], payload.input[1], { type: "compaction_trigger" }]);
  assert.equal(payload.input.length, 2);
  assert.throws(() => rewriteCheckpointMarker({ input: [] }, marker, replacement), /0 checkpoint markers/);
  assert.throws(() => appendCompactionTrigger({ input: [{ type: "compaction_trigger" }] }), /already contains/);
});
