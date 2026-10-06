import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Tool, UserMessage, SystemMessage } from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesMessages, convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { getDeclaredTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { CapableModel } from "../src/capability.js";
import { checkpointMarker, createCheckpointDetails, fallbackSummary, fingerprintMessage } from "../src/checkpoint.js";
import { applyProviderRequest, compactionRequest, providerRequestFor, RequestSnapshotTracker, type ProviderRequestInputs, type RequestDeclarations } from "../src/request-snapshot.js";
import { isObject } from "../src/protocol.js";

const sessionId = "snapshot-session";
const model: Model<"openai-responses"> = {
  id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "custom-codex", api: "openai-responses",
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
  systemPrompt: () => "canonical prompt",
  tools: () => assert.fail("the transcript already declares its tools"),
};
const inputs: ProviderRequestInputs = {
  systemPrompt: "canonical prompt", thinkingLevel: "low", settings: {}, activeTools: ["read"],
  tools: [{ ...tools[0], exposure: "direct", sourceInfo: { path: "<inline:test>", source: "inline", scope: "temporary", origin: "top-level" } }],
};
const noPayload = () => ({ payload: undefined, inputs });

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
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "forced prompt", noPayload);
  assert.equal(tracker.current(), live);
  const snapshot = tracker.current().context;
  assert.ok(snapshot);
  assert.deepEqual(snapshot.messages, projected);
  assert.notEqual(snapshot.messages, projected);
  assert.deepEqual(snapshot.sourceFingerprints, canonical.map(fingerprintMessage));
  assert.deepEqual(live.promptOverride, { sessionId, identity: target.identity,
    sourceFingerprint: fingerprintMessage(canonical[0]), text: "forced prompt" });
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "retry prompt", noPayload);
  assert.equal(live.context, snapshot);
  assert.equal(tracker.current().promptOverride?.text, "retry prompt");
  assert.equal(tracker.current(), live);
});

test("reset clears pending and published state without changing a previously returned view", () => {
  const canonical = [system(), user()];
  const tracker = preparedTracker(canonical);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "forced prompt", noPayload);
  const previous = tracker.current();
  const snapshot = previous.context;
  const override = previous.promptOverride;
  assert.ok(snapshot && override);
  tracker.reset();
  assert.notEqual(tracker.current(), previous);
  assert.deepEqual(tracker.current(), {});
  tracker.recordProviderRequest(sessionId, undefined, () => assert.fail("unsupported provider must not read canonical"),
    () => assert.fail("unsupported provider must not read prompt"), () => assert.fail("unsupported provider must not observe payload"));
  assert.equal(tracker.current().context, undefined);
  assert.equal(tracker.current().promptOverride, undefined);
  assert.equal(previous.context, snapshot);
  assert.equal(previous.promptOverride, override);
  tracker.recordProjectedRequest(sessionId, target, () => assert.fail("reset must also clear the pending source"),
    () => assert.fail("checkpoint must remain lazy"), canonical);
  const next = [system("next prompt"), user("next source", 2)];
  tracker.recordContext(sessionId, target, [next[1]]);
  tracker.recordProjectedRequest(sessionId, target, () => next, () => undefined, next);
  tracker.recordProviderRequest(sessionId, target, () => next, () => "next forced prompt", noPayload);
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
    tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt", noPayload);
    assert.equal(tracker.current().context, undefined);
  });
}

test("canonical matching ignores interleaved system messages and captures a single pending projection", () => {
  const canonical = [system("first prompt"), user("first"), system("latest prompt", 2), user("second", 3)];
  const projected = [system("provider prompt", 2), user("projected conversation", 3)];
  const tracker = preparedTracker(canonical, projected);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "latest prompt", noPayload);
  assert.deepEqual(tracker.current().context?.messages, projected);
  tracker.recordProjectedRequest(sessionId, target, () => assert.fail("a projected source is consumed once"),
    () => assert.fail("no second checkpoint read"), projected);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "latest prompt", noPayload);
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
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt", noPayload);
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
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt", noPayload);
  assert.equal(tracker.current().context, undefined);
});

test("compaction reuses the projected prefix, appends new messages, and does not mutate either input", () => {
  const canonical = [system(), user()];
  const projected = [system(), user("projected source")];
  const tracker = preparedTracker(canonical, projected);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt", noPayload);
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
    tracker.recordProviderRequest(sessionId, target, () => canonical, () => "canonical prompt", noPayload);
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
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "forced prompt", noPayload);
  const result = compactionRequest(tracker.current(), sessionId, target, canonical, declarationsInTranscript);
  assert.deepEqual(result.context, { messages: [{ ...head, content: "forced prompt" }, canonical[1]] });
  assert.deepEqual(canonical[0], head);
});

test("a changed system head invalidates a saved prompt override", () => {
  const canonical = [system(), user()];
  const tracker = new RequestSnapshotTracker();
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => "forced prompt", noPayload);
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
    const probe: UserMessage = { role: "user", content: [image], timestamp: 0 };
    const projected = compactionRequest({}, sessionId, target, [system(), probe], { ...declarationsInTranscript, blockImages: true });
    const projectedUser = projected.context.messages[1];
    assert.equal(projectedUser.role, "user");
    assert.ok(Array.isArray(projectedUser.content));
    const blocked = projectedUser.content[0];
    assert.ok(blocked.type === "text" && blocked.text.length > 0);
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

function observedRequest(canonical: AgentMessage[], payload: unknown, state = inputs) {
  const tracker = preparedTracker(canonical);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => state.systemPrompt, () => ({ payload, inputs: state }));
  return tracker;
}

const wirePayload = () => ({
  model: model.id, instructions: "wire-prompt", tools: [{ type: "function", name: "router", parameters: { type: "object" } }],
  reasoning: { effort: "medium" }, prompt_cache_key: "wire-cache-key", prompt_cache_retention: "24h", service_tier: "priority",
  text: { verbosity: "low", format: { type: "json_object" } },
  input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "wire-prefix" }] },
    { type: "additional_tools", tools: [{ type: "function", name: "internal_read", parameters: { type: "object" } }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "source" }] }],
  max_output_tokens: 123, store: true, stream: false, metadata: { private: "not-copied" },
});

test("observed declarations and cache fields survive newer messages without copying transient state", () => {
  const canonical = [system(), user()];
  const observed = wirePayload();
  const tracker = observedRequest(canonical, observed);
  const current = [...canonical, user("new turn", 2)];
  const snapshot = providerRequestFor(tracker.current(), sessionId, target, current, inputs);
  assert.ok(snapshot?.prefix);
  observed.tools[0].name = "mutated-after-capture";
  observed.input[0].content?.push({ type: "input_text", text: "mutated-after-capture" });
  const fresh = { model: model.id, input: [{ role: "system", content: "fresh prompt" },
    { role: "user", content: [{ type: "input_text", text: snapshot.prefix.boundary }] }, { role: "user", content: "new turn" }],
    tools: [], text: { verbosity: "high" }, max_output_tokens: 4_096, store: false, stream: true };
  const { payload: result } = applyProviderRequest(fresh, target, snapshot);
  const original = wirePayload();
  assert.deepEqual(result.tools, original.tools);
  assert.deepEqual(result.reasoning, original.reasoning);
  assert.equal(result.prompt_cache_key, original.prompt_cache_key);
  assert.equal(result.prompt_cache_retention, original.prompt_cache_retention);
  assert.equal(result.service_tier, original.service_tier);
  assert.deepEqual(result.text, original.text);
  assert.deepEqual(result.input, [...original.input, fresh.input[2]]);
  assert.equal(result.previous_response_id, undefined);
  assert.equal(result.metadata, undefined);
  assert.equal(result.max_output_tokens, fresh.max_output_tokens);
  assert.equal(result.store, fresh.store);
  assert.equal(result.stream, fresh.stream);
  assert.deepEqual(fresh.tools, []);
});

test("wire snapshots reject session, backend, source, prompt, tool, thinking and settings changes", () => {
  const canonical = [system(), user()];
  const tracker = observedRequest(canonical, wirePayload());
  const snapshots = tracker.current();
  assert.equal(providerRequestFor(snapshots, "different-session", target, canonical, inputs), undefined);
  const otherBackend = { ...target, identity: { ...target.identity, baseUrl: "https://other.example", endpoint: "https://other.example/responses" } };
  assert.equal(providerRequestFor(snapshots, sessionId, otherBackend, canonical, inputs), undefined);
  assert.equal(providerRequestFor(snapshots, sessionId, target, [system(), user("edited")], inputs), undefined);
  assert.equal(providerRequestFor(snapshots, sessionId, target, [system()], inputs), undefined);
  for (const changed of [
    { ...inputs, systemPrompt: "updated" },
    { ...inputs, thinkingLevel: "high" as const },
    { ...inputs, activeTools: ["new-tool"] },
    { ...inputs, tools: inputs.tools.map((tool) => ({ ...tool, parameters: { type: "object", properties: { path: { type: "string" } } } })) },
    { ...inputs, settings: { transport: "websocket" as const } },
  ]) assert.equal(providerRequestFor(snapshots, sessionId, target, canonical, changed), undefined);
  const snapshot = providerRequestFor(snapshots, sessionId, target, canonical, inputs);
  assert.ok(snapshot?.prefix);
  const fresh = wirePayload();
  const marked = { ...fresh, input: [...fresh.input, { role: "user", content: [{ type: "input_text", text: snapshot.prefix.boundary }] }] };
  assert.deepEqual(applyProviderRequest(marked, otherBackend, snapshot).payload, fresh);
  assert.throws(() => applyProviderRequest(fresh, target, snapshot), /boundary/);
  assert.throws(() => applyProviderRequest({ ...marked, input: [...marked.input, marked.input.at(-1)] }, target, snapshot), /boundary/);
});

test("missing wire fields remove obsolete defaults and malformed observations discard earlier snapshots", () => {
  const canonical = [system(), user()];
  const payload = { model: model.id, input: [{ role: "user", content: "source" }] };
  const tracker = observedRequest(canonical, payload);
  const snapshot = providerRequestFor(tracker.current(), sessionId, target, canonical, inputs);
  assert.ok(snapshot?.prefix);
  const fresh = wirePayload();
  const actual = applyProviderRequest({ ...fresh, input: [...fresh.input,
    { role: "user", content: [{ type: "input_text", text: snapshot.prefix.boundary }] }] }, target, snapshot).payload;
  assert.equal(actual.instructions, undefined);
  assert.equal(actual.tools, undefined);
  assert.equal(actual.prompt_cache_key, undefined);
  assert.equal(actual.text, undefined);
  for (const invalid of [null, {}, { ...payload, tools: "invalid" }, { ...payload, input: [null] },
    { ...payload, reasoning: false }, { ...payload, text: { verbosity: 2 } }, { ...payload, prompt_cache_key: 1 },
    { ...payload, parallel_tool_calls: "false" }, { ...payload, text: { format: false } },
    { ...payload, prompt_cache_options: true }, { ...payload, prompt_cache_options: { mode: false } }]) {
    tracker.recordProviderRequest(sessionId, target, () => canonical, () => inputs.systemPrompt, () => ({ payload: invalid, inputs }));
    assert.equal(tracker.current().providerRequest, undefined);
  }
});

test("retry observations replace wire fields and reset detaches a captured compaction view", () => {
  const canonical = [system(), user()];
  const tracker = observedRequest(canonical, wirePayload());
  const view = tracker.current();
  const first = view.providerRequest;
  assert.ok(first);
  tracker.recordProviderRequest(sessionId, target, () => canonical, () => inputs.systemPrompt,
    () => ({ payload: { ...wirePayload(), prompt_cache_key: "retried-cache-key" }, inputs }));
  assert.notEqual(view.providerRequest, first);
  assert.equal(view.providerRequest?.fields.prompt_cache_key, "retried-cache-key");
  tracker.reset();
  assert.equal(tracker.current().providerRequest, undefined);
  assert.equal(view.providerRequest?.fields.prompt_cache_key, "retried-cache-key");
});

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`${api} preserves grammar declarations and historical custom-tool calls`, () => {
    const grammar: Tool = { name: "grammar_tool", description: "Grammar fixture",
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
      constrainedSampling: { type: "grammar", variants: { openai_regex: "ping" } } };
    const grammarModel = { ...model, api, compat: { supportsOpenAIGrammarTools: true } };
    const grammarTarget: CapableModel = { model: grammarModel, identity: { ...target.identity, api } };
    const callId = "grammar-call|ctc_history";
    const assistant: AgentMessage = { role: "assistant", content: [{ type: "toolCall", id: callId, name: grammar.name, arguments: { input: "ping" } }],
      api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const resultMessage: AgentMessage = { role: "toolResult", toolCallId: callId, toolName: grammar.name,
      content: [{ type: "text", text: "pong" }], isError: false, timestamp: 3 };
    const canonical: AgentMessage[] = [{ ...system(), toolsAdded: [grammar] }, user(), assistant, resultMessage];
    const saved = structuredClone(canonical);
    const request = compactionRequest({}, sessionId, grammarTarget, canonical, declarationsInTranscript);
    const context = normalizeContext(request.context);
    const converted = convertResponsesMessages(grammarModel, context, new Set([model.provider]), {
      supportsMidConvoSystemMessages: true,
      grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(context.messages), true),
    });
    const wire = { model: model.id, input: converted,
      tools: convertResponsesTools([grammar], { supportsOpenAIGrammarTools: true }) };
    assert.equal(wire.tools[0].type, "custom");
    assert.ok(Array.isArray(wire.input));
    const calls = wire.input.filter(isObject).filter((item) => item.type === "custom_tool_call" || item.type === "custom_tool_call_output");
    assert.equal(calls.length, 2);
    assert.ok(calls[0].type === "custom_tool_call" && calls[1].type === "custom_tool_call_output");
    assert.equal(calls[0].input, "ping");
    assert.equal(calls[1].output, "pong");
    assert.equal(calls[0].call_id, calls[1].call_id);
    assert.deepEqual(request.messages, canonical);
    assert.deepEqual(canonical, saved);
  });
}

test("settled prompt overrides reuse matching wire state but reject a new effective prompt", () => {
  const canonical = [system(), user()];
  const tracker = observedRequest(canonical, wirePayload(), { ...inputs, systemPrompt: "forced prompt" });
  assert.ok(providerRequestFor(tracker.current(), sessionId, target, canonical, inputs));
  assert.ok(providerRequestFor(tracker.current(), sessionId, target, canonical, { ...inputs, systemPrompt: "forced prompt" }));
  assert.equal(providerRequestFor(tracker.current(), sessionId, target, canonical, { ...inputs, systemPrompt: "new configured prompt" }), undefined);
  assert.equal(providerRequestFor(tracker.current(), sessionId, target, canonical, { ...inputs, thinkingLevel: "high" }), undefined);
  const request = compactionRequest(tracker.current(), sessionId, target, canonical,
    { ...declarationsInTranscript, systemPrompt: () => "new configured prompt" });
  assert.deepEqual(request.context.messages, canonical);
});

for (const reference of [
  { previous_response_id: "server-response" },
  { conversation: "server-conversation" },
  { input: [{ type: "item_reference", id: "server-item" }] },
]) {
  test(`server history references preserve locally reconstructed history for ${Object.keys(reference)[0]}`, () => {
    const canonical = [system(), user("full local history")];
    const tracker = observedRequest(canonical, { ...wirePayload(), ...reference });
    const snapshot = providerRequestFor(tracker.current(), sessionId, target, canonical, inputs);
    assert.ok(snapshot);
    assert.equal(snapshot.prefix, undefined);
    const fresh = { model: model.id, input: [{ role: "user", content: "full local history" }] };
    const { payload } = applyProviderRequest(fresh, target, snapshot);
    assert.deepEqual(payload.input, fresh.input);
    assert.equal(payload.previous_response_id, undefined);
    assert.equal(payload.conversation, undefined);
    assert.deepEqual(payload.tools, wirePayload().tools);
    assert.equal(payload.prompt_cache_key, wirePayload().prompt_cache_key);
  });
}
