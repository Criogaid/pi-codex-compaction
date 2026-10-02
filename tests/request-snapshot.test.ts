import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Tool, UserMessage, SystemMessage } from "@earendil-works/pi-ai";
import type { CapableModel } from "../src/capability.js";
import { checkpointMarker, createCheckpointDetails, fallbackSummary, fingerprintMessage } from "../src/checkpoint.js";
import { compactionRequest, RequestSnapshotTracker, type RequestDeclarations } from "../src/request-snapshot.js";

const sessionId = "snapshot-session";
const model: Model<"openai-responses"> = {
  id: "summary", name: "Summary", provider: "custom-codex", api: "openai-responses",
  baseUrl: "https://codex-gateway.example/v1", reasoning: true, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 10_000,
};
const target: CapableModel = {
  model, identity: { provider: model.provider, api: model.api, modelId: model.id,
    baseUrl: model.baseUrl, endpoint: `${model.baseUrl}/responses` },
};
const tools: Tool[] = [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }];
const user = (content = "source", timestamp = 1): UserMessage => ({ role: "user", content, timestamp });
const system = (content = "canonical prompt", timestamp = 0): SystemMessage => ({ role: "system", content, timestamp });
const declarationsInTranscript: RequestDeclarations = {
  blockImages: false,
  systemPrompt: () => assert.fail("the transcript already declares its prompt"),
  tools: () => assert.fail("the transcript already declares its tools"),
};

function preparedTracker(canonical: AgentMessage[], projected: AgentMessage[] = canonical) {
  const tracker = new RequestSnapshotTracker();
  tracker.recordContext(sessionId, target, canonical.filter((message) => message.role !== "system"));
  tracker.recordProjectedRequest(sessionId, target, () => canonical, () => undefined, projected);
  return tracker;
}

test("current returns live published snapshots and provider retries preserve the captured context", () => {
  const tracker = new RequestSnapshotTracker();
  const live = tracker.current();
  const canonical = [system(), user()];
  const projected = [system("projected prompt"), user("projected source")];
  tracker.recordContext(sessionId, target, [user()]);
  tracker.recordProjectedRequest(sessionId, target, () => canonical, () => undefined, projected);
  assert.deepEqual(live.context, undefined);
  assert.deepEqual(live.promptOverride, undefined);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "forced prompt");
  assert.equal(tracker.current(), live);
  const snapshot = tracker.current().context;
  assert.ok(snapshot);
  assert.deepEqual(snapshot.messages, projected);
  assert.notEqual(snapshot.messages, projected);
  assert.deepEqual(snapshot.sourceFingerprints, canonical.map(fingerprintMessage));
  assert.deepEqual(live.promptOverride, { sessionId, identity: target.identity,
    sourceFingerprint: fingerprintMessage(canonical[0]), text: "forced prompt" });
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "retry prompt");
  assert.equal(live.context, snapshot);
  assert.equal(tracker.current().promptOverride?.text, "retry prompt");
  assert.equal(tracker.current(), live);
});

test("reset clears pending and published state without changing a previously returned view", () => {
  const canonical = [system(), user()];
  const tracker = preparedTracker(canonical);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "forced prompt");
  const previous = tracker.current();
  const snapshot = previous.context;
  const override = previous.promptOverride;
  assert.ok(snapshot && override);
  tracker.reset();
  assert.notEqual(tracker.current(), previous);
  assert.deepEqual(tracker.current(), {});
  tracker.recordProviderRequest(sessionId, undefined, () => assert.fail("unsupported provider must not read canonical"),
    () => assert.fail("unsupported provider must not read prompt"));
  assert.equal(tracker.current().context, undefined);
  assert.equal(tracker.current().promptOverride, undefined);
  assert.equal(previous.context, snapshot);
  assert.equal(previous.promptOverride, override);
  tracker.recordProjectedRequest(sessionId, target, () => assert.fail("reset must also clear the pending source"),
    () => assert.fail("checkpoint must remain lazy"), canonical);
  const next = [system("next prompt"), user("next source", 2)];
  tracker.recordContext(sessionId, target, [next[1]]);
  tracker.recordProjectedRequest(sessionId, target, () => next, () => undefined, next);
  tracker.recordProviderRequest(sessionId, target, () => next, () => "next forced prompt");
  assert.deepEqual(tracker.current().context?.messages, next);
  assert.equal(previous.context, snapshot);
  assert.equal(previous.promptOverride, override);
});

for (const scenario of ["no source", "no target", "different session", "changed text", "changed timestamp", "extra message"] as const) {
  test(`recordProjectedRequest rejects ${scenario} and consumes the pending source`, (t) => {
    const canonical = [system(), user()];
    const tracker = new RequestSnapshotTracker();
    if (scenario !== "no source") tracker.recordContext(sessionId, target, [user()]);
    const messages = scenario === "changed text" ? [system(), user("changed")]
      : scenario === "changed timestamp" ? [system(), user("source", 2)]
      : scenario === "extra message" ? [...canonical, user("extra", 2)] : canonical;
    const readCanonical = t.mock.fn(() => messages);
    const readCheckpoint = t.mock.fn(() => undefined);
    tracker.recordProjectedRequest(scenario === "different session" ? "other-session" : sessionId,
      scenario === "no target" ? undefined : target, readCanonical, readCheckpoint, canonical);
    assert.equal(readCanonical.mock.callCount(), ["changed text", "changed timestamp", "extra message"].includes(scenario) ? 1 : 0);
    assert.equal(readCheckpoint.mock.callCount(), 0);
    tracker.recordProjectedRequest(sessionId, target, () => assert.fail("a rejected source is consumed"), readCheckpoint, canonical);
    tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt");
    assert.equal(tracker.current().context, undefined);
  });
}

test("canonical matching ignores interleaved system messages and captures a single pending projection", () => {
  const canonical = [system("first prompt"), user("first"), system("latest prompt", 2), user("second", 3)];
  const projected = [system("provider prompt", 2), user("projected conversation", 3)];
  const tracker = preparedTracker(canonical, projected);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "latest prompt");
  assert.deepEqual(tracker.current().context?.messages, projected);
  tracker.recordProjectedRequest(sessionId, target, () => assert.fail("a projected source is consumed once"),
    () => assert.fail("no second checkpoint read"), projected);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "latest prompt");
  assert.equal(tracker.current().context, undefined);
});

test("a checkpoint projects the source before binding and reusing the ordinary request", () => {
  const kept = user("kept", 2);
  const details = createCheckpointDetails({ identity: target.identity, checkpointId: "snapshot-checkpoint",
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }], keptMessages: [kept] });
  const summary: AgentMessage = { role: "compactionSummary", summary: fallbackSummary(details.checkpointId), tokensBefore: 100, timestamp: 1 };
  const head = system();
  const after = user("after", 3);
  const canonical = [head, summary, kept, after];
  const projected = [head, user("provider projection", 1), after];
  const marker: UserMessage = { role: "user", content: [{ type: "text", text: checkpointMarker(details.checkpointId) }], timestamp: 1 };
  const source = [head, marker, after];
  const tracker = new RequestSnapshotTracker();
  tracker.recordContext(sessionId, target, [summary, kept, after]);
  tracker.recordProjectedRequest(sessionId, target, () => canonical, () => details, projected);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt");
  assert.deepEqual(tracker.current().context?.sourceFingerprints, source.map(fingerprintMessage));
  const result = compactionRequest(tracker.current(), sessionId, target, source, declarationsInTranscript);
  assert.deepEqual(result.messages, projected);
  assert.deepEqual(result.context, { messages: projected });
});

test("an invalid checkpoint projection cannot publish an ordinary context snapshot", () => {
  const details = createCheckpointDetails({ identity: target.identity, checkpointId: "invalid-projection",
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }], keptMessages: [user("kept", 2)] });
  const canonical: AgentMessage[] = [system(), { role: "compactionSummary", summary: fallbackSummary(details.checkpointId), tokensBefore: 100, timestamp: 1 }, user("edited kept", 2)];
  const tracker = new RequestSnapshotTracker();
  tracker.recordContext(sessionId, target, canonical.filter((message) => message.role !== "system"));
  tracker.recordProjectedRequest(sessionId, target, () => canonical, () => details, canonical);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt");
  assert.equal(tracker.current().context, undefined);
});

test("compaction reuses the projected prefix, appends new messages, and does not mutate either input", () => {
  const canonical = [system(), user()];
  const projected = [system(), user("projected source")];
  const tracker = preparedTracker(canonical, projected);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt");
  const current = [...canonical, user("new suffix", 2)];
  const saved = structuredClone({ current, projected });
  const result = compactionRequest(tracker.current(), sessionId, target, current, declarationsInTranscript);
  assert.deepEqual(result.messages, [...projected, current[2]]);
  assert.deepEqual(result.context, { messages: [...projected, current[2]] });
  assert.notEqual(result.messages[1], projected[1]);
  assert.deepEqual({ current, projected }, saved);
});

for (const scenario of ["session", "model", "backend", "changed prefix", "shortened prefix"] as const) {
  test(`compaction rejects a snapshot with a mismatched ${scenario}`, () => {
    const canonical = [system(), user()];
    const tracker = preparedTracker(canonical, [system(), user("must not be reused")]);
    tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt");
    const requestTarget = scenario === "model" ? { ...target, model: { ...model, id: "other" }, identity: { ...target.identity, modelId: "other" } }
      : scenario === "backend" ? { ...target, identity: { ...target.identity, endpoint: "https://other.example/responses" } } : target;
    const current = scenario === "changed prefix" ? [system(), user("edited")]
      : scenario === "shortened prefix" ? [system()] : canonical;
    const result = compactionRequest(tracker.current(), scenario === "session" ? "other-session" : sessionId,
      requestTarget, current, declarationsInTranscript);
    assert.deepEqual(result.context, { messages: current });
    assert.equal(result.messages, current);
  });
}

test("a prompt override replaces the system text while retaining transcript tools and omitting fallback declarations", () => {
  const head: SystemMessage = { ...system(), toolsAdded: tools };
  const canonical = [head, user()];
  const tracker = preparedTracker(canonical);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "forced prompt");
  const result = compactionRequest(tracker.current(), sessionId, target, canonical, declarationsInTranscript);
  assert.deepEqual(result.context, { messages: [{ ...head, content: "forced prompt" }, canonical[1]] });
  assert.deepEqual(canonical[0], head);
});

test("a changed system head invalidates a saved prompt override", () => {
  const canonical = [system(), user()];
  const tracker = new RequestSnapshotTracker();
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "forced prompt");
  const current = [system("edited canonical prompt"), user()];
  const result = compactionRequest(tracker.current(), sessionId, target, current, declarationsInTranscript);
  assert.deepEqual(result.context, { messages: current });
});

test("a transcript without system messages reads and includes the supplied prompt and tools", (t) => {
  const current = [user()];
  const systemPrompt = t.mock.fn(() => "declared prompt");
  const readTools = t.mock.fn(() => tools);
  const result = compactionRequest({}, sessionId, target, current, { blockImages: false, systemPrompt, tools: readTools });
  assert.deepEqual(result.context, { systemPrompt: "declared prompt", tools, messages: current });
  assert.equal(result.messages, current);
  assert.equal(systemPrompt.mock.callCount(), 1);
  assert.equal(readTools.mock.callCount(), 1);
});

for (const blockImages of [true, false]) {
  test(`image blocking ${blockImages} preserves text order and deduplicates only adjacent placeholders`, () => {
    const image = { type: "image" as const, data: "fixture", mimeType: "image/png" };
    const blocked = { type: "text" as const, text: "Image reading is disabled." };
    const text = { type: "text" as const, text: "between images" };
    const content = [image, image, blocked, text, image, image];
    const head = system();
    const imageUser: UserMessage = { role: "user", content, timestamp: 1 };
    const tool: AgentMessage = { role: "toolResult", toolCallId: "read-call", toolName: "read", content, isError: false, timestamp: 2 };
    const textOnly: UserMessage = { role: "user", content: [blocked, blocked], timestamp: 3 };
    const current = [head, imageUser, tool, textOnly];
    const saved = structuredClone(current);
    const result = compactionRequest({}, sessionId, target, current, { ...declarationsInTranscript, blockImages });
    const expected = blockImages ? [blocked, text, blocked] : content;
    assert.deepEqual(result.context, { messages: [head, { ...imageUser, content: expected }, { ...tool, content: expected }, textOnly] });
    assert.deepEqual(current, saved);
  });
}
