import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexCompactionProtocolError, appendCompactionTrigger, createCompactionCollector, isObject, prepareRemoteCompactionPayload, rewriteCheckpointMarker } from "../src/protocol.js";

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
  assert.throws(() => collector.finish(), CodexCompactionProtocolError);
});

test("requires output_item.done and response.completed", () => {
  const missingItem = createCompactionCollector();
  missingItem.observe(completed);
  assert.throws(() => missingItem.finish(), CodexCompactionProtocolError);
  const incomplete = createCompactionCollector();
  incomplete.observe(done);
  assert.throws(() => incomplete.finish(), CodexCompactionProtocolError);
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
  assert.throws(() => rewriteCheckpointMarker({ input: [] }, marker, replacement), CodexCompactionProtocolError);
  assert.throws(() => appendCompactionTrigger({ input: [{ type: "compaction_trigger" }] }), CodexCompactionProtocolError);
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
  assert.throws(() => prepareRemoteCompactionPayload(payload, undefined, () => ({ input: "invalid" })), CodexCompactionProtocolError);
});

test("does not adapt malformed payloads or failed marker substitutions", () => {
  const adapt = () => assert.fail("invalid history must not reach the adapter");
  assert.throws(() => prepareRemoteCompactionPayload(null, undefined, adapt), CodexCompactionProtocolError);
  assert.throws(() => prepareRemoteCompactionPayload({ input: [] }, { marker: "missing", replacementHistory: [] }, adapt), CodexCompactionProtocolError);
  const reason = new Error("adaptation failed");
  assert.throws(() => prepareRemoteCompactionPayload({ input: [] }, undefined, () => { throw reason; }), (error) => error === reason);
});
