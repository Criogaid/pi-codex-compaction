// Compare compaction with Pi's real provider adapters without making network requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import type { AssistantMessage, Context, Model, Provider } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { capableModel } from "../src/capability.js";
import { isObject, isObjectArray, type JsonObject } from "../src/protocol.js";
import { compactionRequest, RequestSnapshotTracker, type ProviderRequestInputs } from "../src/request-snapshot.js";
import { requestRemoteCompaction } from "../src/remote.js";
import { assertTrimmedOutput, mockFetch, testRegistry, withResponsesPayloadHook } from "./helpers.js";

const apiKey = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
})).toString("base64url")}.fixture`;
const context: Context = {
  systemPrompt: "Preserve the session settings.",
  messages: [{ role: "user", content: "Remember the code ORBIT-47.", timestamp: 1 }],
};
const sessionId = "compaction-runtime-fixture";

function response(): Response {
  const item = { type: "compaction", encrypted_content: "fixture-opaque" };
  return new Response([
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: {
      id: "resp-fixture", status: "completed", output: [item],
      usage: { input_tokens: 20, output_tokens: 1, input_tokens_details: { cached_tokens: 10 } },
    } })}\n\n`,
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const reasoning of ["off", "medium", "high", "max"] satisfies ThinkingLevel[]) {
    test(`${api} compaction inherits ${reasoning} thinking and session caching`, async () => {
      const provider: Provider = api === "openai-responses" ? openaiProvider() : openaiCodexProvider();
      const model: Model<typeof api> = {
        id: "fixture-model", name: "Fixture", api, provider: provider.id,
        baseUrl: "https://gateway.example/v1", reasoning: true, input: ["text"],
        contextWindow: 100_000, maxTokens: 10_000,
        thinkingLevelMap: { off: "none", medium: "medium", high: "high", max: "xhigh" },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsLongCacheRetention: true, supportsExplicitPromptCacheMode: true, ...{ remoteCompaction: { protocol: "v2" } } },
      };
      const modelRegistry = await testRegistry(provider, async () => ({ auth: { apiKey }, env: { PI_CACHE_RETENTION: "long" } }));
      let ordinaryPayload: unknown;
      let compactPayload: unknown;
      let ordinaryHeaders: Headers | undefined;
      let compactHeaders: Headers | undefined;
      const ordinary = modelRegistry.streamSimple(model, context, {
        reasoning: reasoning === "off" ? undefined : reasoning,
        sessionId, transport: "sse",
        onPayload: (payload) => { ordinaryPayload = JSON.parse(JSON.stringify(payload)); },
        fetch: async (input, init) => {
          ordinaryHeaders = new Request(input, init).headers;
          return response();
        },
      });
      for await (const event of ordinary) {
        if (event.type === "error") throw new Error(event.error.errorMessage);
      }
      using _fetchScope = mockFetch(async (input, init) => {
        const request = new Request(input, init);
        const bytes = Buffer.from(await request.arrayBuffer());
        const json = request.headers.get("content-encoding") === "zstd"
          ? zstdDecompressSync(bytes).toString("utf8")
          : bytes.toString("utf8");
        compactPayload = JSON.parse(json);
        compactHeaders = request.headers;
        return response();
      });
      await requestRemoteCompaction({
        modelRegistry, model, context, reasoning, reasoningEffortUpdates: false, sessionId,
        signal: new AbortController().signal,
      });
      assert.ok(ordinaryPayload && typeof ordinaryPayload === "object");
      const expected = ordinaryPayload as { input: unknown[] };
      assert.deepEqual(compactPayload, {
        ...expected, input: [...expected.input, { type: "compaction_trigger" }],
      });
      for (const header of ["session-id", "x-client-request-id", "chatgpt-account-id"]) {
        assert.equal(compactHeaders?.get(header), ordinaryHeaders?.get(header), header);
      }
    });
  }
}

test("V2 rewrites only the sent body, preserving Pi effort updates in the checkpoint input", async () => {
  const provider = openaiProvider();
  const compat = { supportsLongCacheRetention: true, supportsMidConvoEffort: true };
  const model: Model<"openai-responses"> = {
    id: "gpt-fixture", name: "Fixture", api: "openai-responses", provider: provider.id,
    baseUrl: "https://gateway.example/v1", reasoning: true, input: ["text"],
    contextWindow: 100_000, maxTokens: 10_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { ...compat },
  };
  const target = capableModel(model);
  assert.ok(target);
  const update = { type: "configuration_update", reasoning: { effort: "low" } };
  const registry = await testRegistry(withResponsesPayloadHook(provider, (payload) => ({
    ...payload, input: [...payload.input.flatMap((item) => item.role === "assistant" ? [update, item] : [item]), update],
  })));
  const canonical = [{ role: "system" as const, content: "Preserve settings.", timestamp: 0 },
    { role: "user" as const, content: "source", timestamp: 1 }];
  const inputs: ProviderRequestInputs = { systemPrompt: "Preserve settings.", thinkingLevel: "low", settings: {}, activeTools: [], tools: [] };
  const tracker = new RequestSnapshotTracker();
  tracker.recordContext(sessionId, target, () => canonical);
  tracker.recordProjectedRequest(sessionId, target, () => canonical, () => undefined, canonical, false);
  let observed: JsonObject | undefined;
  const assistant = await registry.streamSimple(model, { messages: canonical }, {
    reasoning: "low", transport: "sse",
    onPayload: (payload) => {
      assert.ok(isObject(payload));
      observed = structuredClone(payload);
      tracker.recordProviderRequest(sessionId, target, () => canonical, () => inputs.systemPrompt, () => ({ payload, inputs, replay: "skipped" }));
    },
    fetch: async () => response(),
  }).result();
  assert.notEqual(assistant.stopReason, "error", assistant.errorMessage ?? "ordinary request failed");
  assert.ok(observed && Array.isArray(observed.input));
  assert.deepEqual(observed.input.at(-1), update);
  const current = [...canonical, { ...assistant, content: [{ type: "text" as const, text: "reply" }], timestamp: 2 }];
  const request = compactionRequest(tracker.current(), sessionId, target, current, inputs, { blockImages: false, tools: () => [] });
  assert.ok(request.providerRequest?.prefix);
  for (const reasoningEffortUpdates of [false, true]) {
    const attempts: JsonObject[] = [];
    using _fetchScope = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      const bytes = Buffer.from(await request.arrayBuffer());
      const decoded = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
      const payload: unknown = JSON.parse(decoded.toString("utf8"));
      assert.ok(isObject(payload));
      attempts.push(payload);
      return attempts.length === 1
        ? new Response("busy", { status: 503, headers: { "retry-after-ms": "1" } })
        : response();
    });
    const result = await requestRemoteCompaction({
      modelRegistry: registry, model, context: request.context, providerRequest: request.providerRequest,
      reasoning: "low", sessionId, signal: AbortSignal.timeout(5_000), maxRetries: 1, maxRetryDelayMs: 1,
      reasoningEffortUpdates,
    });
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    const sent = attempts[0];
    assert.ok(isObjectArray(sent.input));
    assert.deepEqual(sent.input.at(-1), { type: "compaction_trigger" });
    const wireInput = sent.input.slice(0, -1);
    const { promptInput } = result;
    assert.equal(result.contextual.length, promptInput.length);
    assert.deepEqual(JSON.parse(JSON.stringify(promptInput.slice(0, observed.input.length - 1))),
      JSON.parse(JSON.stringify(observed.input.slice(0, -1))));
    assert.ok(promptInput.some((item) => item.role === "assistant"));
    assert.deepEqual(promptInput.filter((item) => item.type === "configuration_update"), [update, update]);
    assert.notEqual(promptInput.at(-1)?.type, "compaction_trigger");
    for (let index = 1; index < promptInput.length; index++) {
      assert.ok(promptInput[index - 1].type !== "configuration_update" || promptInput[index].type !== "configuration_update");
    }
    const expectedInput = reasoningEffortUpdates ? promptInput.slice(0, -1) : promptInput;
    assert.equal(promptInput.at(-1)?.type, "configuration_update");
    assert.deepEqual(wireInput, JSON.parse(JSON.stringify(expectedInput)));
  }
});

for (const path of ["matching prefix", "no snapshot", "settings mismatch", "server reference"] as const) {
  test(`V2 trims only history with ${path}`, async () => {
    const provider = openaiProvider();
    const model: Model<"openai-responses"> = {
      id: "gpt-fixture", name: "Fixture", api: "openai-responses", provider: provider.id,
      baseUrl: "https://gateway.example/v1", reasoning: true, input: ["text"],
      contextWindow: 72, maxTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const target = capableModel(model);
    assert.ok(target);
    const inputs: ProviderRequestInputs = { systemPrompt: "Keep facts.", thinkingLevel: "low", settings: {}, activeTools: [], tools: [] };
    const callId = "call_lookup|fc_lookup";
    const toolCall: AssistantMessage = {
      role: "assistant", content: [{ type: "toolCall", id: callId, name: "lookup", arguments: {} }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const toolOutput = "x".repeat(400);
    const history: Context["messages"] = [
      { role: "user", content: "Look it up.", timestamp: 1 }, toolCall,
      { role: "toolResult", toolCallId: callId, toolName: "lookup", isError: false, timestamp: 3,
        content: [{ type: "text", text: toolOutput }] },
    ];
    const reply: AssistantMessage = { ...toolCall, timestamp: 4, stopReason: "stop",
      content: [{ type: "text", text: "Found it.", textSignature: "msg_reply" }],
    };
    const historyUpdate = { type: "configuration_update", reasoning: { effort: "medium" } };
    const observedUpdate = { type: "configuration_update", reasoning: { effort: "high" } };
    const currentUpdate = { type: "configuration_update", reasoning: { effort: "low" } };
    const trigger = { type: "compaction_trigger" };
    const wirePrefix = [
      { role: "developer", content: inputs.systemPrompt },
      { role: "user", content: [{ type: "input_text", text: "Look it up." }] },
      { type: "function_call", id: path === "matching prefix" ? "fc_observed" : "fc_lookup",
        call_id: "call_lookup", name: "lookup", arguments: "{}" },
    ];
    const wireOutput = { type: "function_call_output", call_id: "call_lookup", output: toolOutput };
    const wireReply = { type: "message", role: "assistant", id: "msg_reply", status: "completed",
      content: [{ type: "output_text", text: "Found it.", annotations: [] }],
    };

    const send = async (messages: AgentMessage[], requestTail: readonly JsonObject[] = []) => {
      const registry = await testRegistry(withResponsesPayloadHook(provider, (payload) => ({
        ...payload, input: [...payload.input.flatMap((item) => item.role === "assistant" ? [historyUpdate, item] : [item]), ...requestTail],
      })));
      const tracker = new RequestSnapshotTracker();
      if (path !== "no snapshot") {
        tracker.recordContext(sessionId, target, () => history);
        tracker.recordProjectedRequest(sessionId, target, () => history, () => undefined, history, false);
        const ordinary = await registry.streamSimple(model, { systemPrompt: inputs.systemPrompt, messages: history }, {
          reasoning: "low", transport: "sse", sessionId,
          onPayload: (payload) => {
            assert.ok(isObject(payload) && isObjectArray(payload.input));
            // A distinct wire ID shows whether compaction reused the observed prefix.
            const observedInput = payload.input.slice(0, payload.input.length - requestTail.length)
              .map((item) => item.type === "function_call" ? { ...item, id: "fc_observed" } : item);
            if (requestTail.length) observedInput.push(observedUpdate);
            const observed = { ...payload, input: observedInput, service_tier: "priority",
              ...(path === "server reference" ? { previous_response_id: "resp-observed" } : {}),
            };
            tracker.recordProviderRequest(sessionId, target, () => history, () => inputs.systemPrompt,
              () => ({ payload: observed, inputs, replay: "skipped" }));
            return observed;
          },
          fetch: async () => response(),
        }).result();
        assert.notEqual(ordinary.stopReason, "error", ordinary.errorMessage ?? "ordinary request failed");
        assert.ok(tracker.current().providerRequest);
      }
      const currentInputs = path === "settings mismatch" ? { ...inputs, settings: { transport: "websocket" as const } } : inputs;
      const request = compactionRequest(tracker.current(), sessionId, target, messages, currentInputs, { blockImages: false, tools: () => [] });
      assert.equal(Boolean(request.providerRequest), path === "matching prefix" || path === "server reference");
      assert.equal(Boolean(request.providerRequest?.prefix), path === "matching prefix");

      let sent: unknown;
      using _fetchScope = mockFetch(async (input, init) => { sent = await new Request(input, init).json(); return response(); });
      await requestRemoteCompaction({
        modelRegistry: registry, model, context: request.context, providerRequest: request.providerRequest,
        reasoning: "low", reasoningEffortUpdates: false, sessionId, signal: AbortSignal.timeout(5_000), maxRetries: 0,
      });
      assert.ok(isObject(sent) && isObjectArray(sent.input));
      assert.equal(sent.service_tier, request.providerRequest ? "priority" : undefined);
      assert.equal(sent.previous_response_id, undefined);
      return sent.input;
    };

    const noTail = await send(history);
    const trimmed = assertTrimmedOutput(noTail[wirePrefix.length], wireOutput);
    assert.equal(Buffer.byteLength(String(trimmed.output)), 61, "Tool output bytes without a request tail");
    assert.deepEqual(noTail, [...wirePrefix, trimmed, trigger]);

    // A non-empty assistant reply keeps the earlier tool result outside the trimmable suffix.
    const historyOnly = await send([...history, reply]);
    assert.deepEqual(historyOnly, [...wirePrefix, wireOutput, historyUpdate, wireReply, trigger]);

    const withTail = await send(history, [currentUpdate]);
    const actualOutput = withTail[wirePrefix.length]?.output;
    assert.ok(typeof actualOutput === "string");
    assert.equal(Buffer.byteLength(actualOutput), 61, "Tool output bytes with a request tail");
    assert.deepEqual(withTail, [...wirePrefix, trimmed, currentUpdate, trigger]);
  });
}

test("V2 uses a fresh HTTP request with its feature header after an ordinary WebSocket request", async () => {
  const provider = openaiCodexProvider();
  const model: Model<"openai-codex-responses"> = {
    id: "gpt-fixture", name: "Fixture", api: "openai-codex-responses", provider: provider.id,
    baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
    contextWindow: 100_000, maxTokens: 10_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let socketRequests = 0;
  let httpRequests = 0;
  const originalSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class extends EventTarget {
    readyState = 1;
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    close() { this.readyState = 3; }
    send() {
      socketRequests++;
      setTimeout(() => {
        const item = { type: "compaction", encrypted_content: "fixture-opaque" };
        const result = { id: "resp-socket", status: "completed", output: [item],
          usage: { input_tokens: 20, output_tokens: 1 } };
        for (const event of [
          { type: "response.created", response: result },
          { type: "response.output_item.done", item },
          { type: "response.completed", response: result },
        ]) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
      }, 0);
    }
  } });
  try {
    const modelRegistry = await testRegistry(provider, async () => ({ auth: { apiKey } }));
    const ordinary = await modelRegistry.streamSimple(model, context, {
      sessionId, transport: "auto", signal: AbortSignal.timeout(5_000),
      fetch: async () => { throw new Error("Unexpected ordinary HTTP fallback"); },
    }).result();
    assert.notEqual(ordinary.stopReason, "error", ordinary.errorMessage ?? "ordinary request failed");
    using _fetchScope = mockFetch(async (input, init) => {
      httpRequests++;
      const outgoing = new Request(input, init);
      assert.equal(outgoing.headers.get("x-codex-beta-features"), "remote_compaction_v2");
      assert.equal(outgoing.headers.get("session-id"), sessionId);
      return response();
    });
    await requestRemoteCompaction({
      modelRegistry, model, context, reasoning: "high", reasoningEffortUpdates: false, sessionId,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(httpRequests, 1);
    assert.equal(socketRequests, 1, "compaction must not reuse the ordinary connection");
  } finally {
    closeOpenAICodexWebSocketSessions(sessionId);
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: originalSocket });
  }
});
