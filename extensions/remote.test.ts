import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { mergeRemoteCompactionHeader, requestRemoteCompaction } from "./remote.js";
import { testRegistry } from "./test-registry.test.js";
import { isObject, type JsonObject } from "./protocol.js";
import { prepareRetention } from "./retention-input.js";
import { buildReplacementHistory } from "./retention.js";

const provider = openaiProvider();
const model: Model<"openai-responses"> = {
  id: "fixture-model", name: "Fixture", api: "openai-responses", provider: provider.id,
  baseUrl: "https://gateway.example/v1", reasoning: true, input: ["text"],
  contextWindow: 100_000, maxTokens: 10_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsLongCacheRetention: true, ...{ remoteCompaction: { protocol: "v2" } } },
};
const originalImage = { type: "input_image", detail: "original",
  image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
function response() {
  const item = { type: "compaction", encrypted_content: "opaque" };
  return new Response([
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-fixture", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 1 } } })}\n\n`,
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}
function request(modelRegistry: Awaited<ReturnType<typeof testRegistry>>) {
  return { modelRegistry, model, context: { messages: [{ role: "user" as const, content: "current", timestamp: 1 }] },
    reasoning: "high" as const, sessionId: "session",
    signal: new AbortController().signal };
}

test("merges the V2 beta feature without dropping existing features", () => {
  assert.deepEqual(mergeRemoteCompactionHeader({ "X-Codex-Beta-Features": "feature_a,remote_compaction_v2" }),
    { "x-codex-beta-features": "feature_a,remote_compaction_v2" });
});

test("Pi resolves model headers, auth headers, scoped env, and the actual endpoint", async () => {
  const registry = await testRegistry(provider, async () => ({
    auth: { apiKey: "fixture-key", baseUrl: "https://resolved.example/api", headers: { "x-auth": "fixture", "x-codex-beta-features": "existing" } },
    env: { PI_CACHE_RETENTION: "long" },
  }));
  let sent: Record<string, unknown> | undefined;
  const result = await requestRemoteCompaction({ ...request(registry), model: { ...model, headers: { "x-model": "fixture" }, compat: { ...model.compat, supportsLongCacheRetention: true } },
    fetch: async (input, init) => {
      const outgoing = new Request(input, init);
      assert.equal(outgoing.url, "https://resolved.example/api/responses");
      assert.equal(outgoing.headers.get("x-model"), "fixture");
      assert.equal(outgoing.headers.get("x-auth"), "fixture");
      assert.equal(outgoing.headers.get("x-codex-beta-features"), "existing,remote_compaction_v2");
      sent = await outgoing.json() as Record<string, unknown>;
      return response();
    },
  });
  assert.equal(result.identity.baseUrl, "https://resolved.example/api");
  assert.equal(result.identity.endpoint, "https://resolved.example/api/responses");
  assert.equal(result.item.encrypted_content, "opaque");
  assert.deepEqual((sent?.input as unknown[]).at(-1), { type: "compaction_trigger" });
  assert.equal(sent?.prompt_cache_key, "session");
  assert.equal(sent?.prompt_cache_retention, "24h");
});

test("routes an explicit same-origin HTTP endpoint without changing the provider model", async () => {
  const registry = await testRegistry(provider);
  const endpoint = "https://gateway.example/custom/responses";
  await requestRemoteCompaction({ ...request(registry),
    model: { ...model, compat: { ...model.compat, ...{ remoteCompaction: { protocol: "v2", endpoint } } } },
    fetch: async (input, init) => {
      assert.equal(new Request(input, init).url, endpoint);
      return response();
    },
  });
});

test("repeated compaction expands a compatible checkpoint before the final trigger", async () => {
  const registry = await testRegistry(provider);
  const identity = { provider: model.provider, api: model.api, modelId: model.id, baseUrl: model.baseUrl, endpoint: `${model.baseUrl}/responses` };
  await requestRemoteCompaction({ ...request(registry),
    context: { messages: [{ role: "user", content: "checkpoint marker", timestamp: 1 }] },
    priorCheckpoint: { identity, marker: "checkpoint marker", replacementHistory: [{ type: "compaction", encrypted_content: "prior" }] },
    fetch: async (input, init) => {
      const payload = await new Request(input, init).json() as { input: Array<Record<string, unknown>> };
      assert.equal(payload.input[0].encrypted_content, "prior");
      assert.deepEqual(payload.input.at(-1), { type: "compaction_trigger" });
      return response();
    },
  });
});

test("rejects a prior checkpoint when authentication changes the endpoint", async () => {
  const registry = await testRegistry(provider, async () => ({ auth: { apiKey: "fixture-key", baseUrl: "https://other.example/v1" } }));
  let sent = false;
  await assert.rejects(requestRemoteCompaction({ ...request(registry),
    priorCheckpoint: { identity: { provider: model.provider, api: model.api, modelId: model.id, baseUrl: model.baseUrl, endpoint: `${model.baseUrl}/responses` }, marker: "checkpoint marker", replacementHistory: [{ type: "compaction", encrypted_content: "prior" }] },
    fetch: async () => { sent = true; return response(); },
  }), /different resolved provider backend/);
  assert.equal(sent, false);
});

test("accepts header-only auth and provider-owned event streams", async () => {
  const codexModel = { ...model, api: "openai-codex-responses" as const };
  const eventProvider: Provider = {
    ...provider, getModels: () => [codexModel],
    streamSimple(preparedModel, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [], api: preparedModel.api, provider: preparedModel.provider, model: preparedModel.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: 1,
      };
      void (async () => {
        try {
          assert.equal(options?.apiKey, undefined);
          assert.equal(options?.headers?.cookie, "fixture-cookie");
          assert.equal(options?.transport, "sse");
          await options?.onPayload?.({ model: preparedModel.id, input: [] }, preparedModel);
          const item = { type: "compaction", encrypted_content: "provider-opaque" };
          await options?.onProviderStreamEvent?.({ type: "response.output_item.done", item }, preparedModel);
          await options?.onProviderStreamEvent?.({ type: "response.completed" }, preparedModel);
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        } catch (error) {
          const failed: AssistantMessage = { ...message, stopReason: "error", errorMessage: String(error) };
          stream.push({ type: "error", reason: "error", error: failed });
          stream.end(failed);
        }
      })();
      return stream;
    },
  };
  const registry = await testRegistry(eventProvider, async () => ({ auth: { headers: { cookie: "fixture-cookie" } } }));
  const result = await requestRemoteCompaction({ ...request(registry), model: codexModel,
    fetch: async () => { assert.fail("Custom provider owns its transport"); },
  });
  assert.equal(result.item.encrypted_content, "provider-opaque");
});

for (const fault of ["endpoint", "method", "feature-header", "model"] as const) {
  const title = fault === "feature-header" ? "accepts a provider request without the beta header"
    : `rejects provider ${fault} substitution before sending a request`;
  test(title, async () => {
    const faultyProvider: Provider<"openai-responses"> = {
      ...provider,
      streamSimple(preparedModel, transcript, options) {
        assert.ok(options?.fetch);
        const routedFetch = options.fetch;
        return provider.streamSimple(preparedModel, transcript, {
          ...options,
          onPayload: (payload, currentModel) => options.onPayload?.(
            fault === "model" && typeof payload === "object" && payload !== null
              ? { ...payload, model: "other-model" } : payload, currentModel,
          ),
          fetch: (input, init) => {
            const outgoing = new Request(input, init);
            const headers = new Headers(outgoing.headers);
            if (fault === "feature-header") headers.delete("x-codex-beta-features");
            return routedFetch(fault === "endpoint" ? "https://other.example/responses" : input, {
              ...init, headers, method: fault === "method" ? "GET" : outgoing.method,
            });
          },
        });
      },
    };
    const registry = await testRegistry(faultyProvider);
    let sent = false;
    const pending = requestRemoteCompaction({ ...request(registry), maxRetries: 0,
      fetch: async () => { sent = true; return response(); },
    });
    if (fault === "feature-header") {
      assert.equal((await pending).item.encrypted_content, "opaque");
      assert.equal(sent, true);
    } else {
      // Pi's OpenAI adapter wraps fetch failures as connection errors.
      await assert.rejects(pending, fault === "model" ? /unexpected model/ : /Connection error/);
      assert.equal(sent, false);
    }
  });
}

for (const [configured, retries] of [[undefined, 2], [0, 0], [1, 1], [2, 2], [9, 2]] as const) {
  test(`caps provider retries at ${retries} when configured as ${configured}`, async () => {
    let observed: SimpleStreamOptions | undefined;
    const observedProvider: Provider<"openai-responses"> = { ...provider, streamSimple(preparedModel, transcript, options) {
      observed = options;
      return provider.streamSimple(preparedModel, transcript, options);
    } };
    const registry = await testRegistry(observedProvider);
    let attempts = 0;
    await assert.rejects(requestRemoteCompaction({ ...request(registry), maxRetries: configured, maxRetryDelayMs: 1,
      fetch: async () => {
        attempts++;
        return new Response(JSON.stringify({ error: { message: "fixture unavailable" } }), {
          status: 503, headers: { "content-type": "application/json", "retry-after-ms": "1" },
        });
      },
    }), /fixture unavailable/);
    assert.equal(observed?.maxRetries, retries);
    assert.equal(observed?.maxRetryDelayMs, 1);
    assert.equal(attempts, retries + 1);
  });
}

function providerInput(input: readonly JsonObject[]): Provider<"openai-responses"> {
  return { ...provider, streamSimple(preparedModel, transcript, options) {
    return provider.streamSimple(preparedModel, transcript, { ...options, onPayload: (payload, currentModel) => {
      assert.ok(isObject(payload));
      return options?.onPayload?.({ ...payload, input }, currentModel);
    } });
  } };
}

test("returns trimmed promptInput and contextual flags matching the actual provider payload", async () => {
  const hidden = { role: "user", content: [{ type: "input_text", text: "hidden" }] };
  const visible = { role: "user", content: [{ type: "input_text", text: "visible" }] };
  const notice = { role: "developer", content: [{ type: "input_text", text: "<image_resize_notice>resized</image_resize_notice>" }] };
  const output = { type: "function_call_output", call_id: "call", output: "x".repeat(400) };
  const input = [hidden, notice, visible, output, notice];
  const saved = structuredClone(input);
  const registry = await testRegistry(providerInput(input));
  let sent: unknown;
  const result = await requestRemoteCompaction({ ...request(registry), model: { ...model, contextWindow: 80 },
    userItemOrigins: ["context", "user"],
    fetch: async (input, init) => { sent = await new Request(input, init).json(); return response(); },
  });
  const expected = [hidden, notice, visible, { ...output, output: "Output exceeded the available model context and was truncated" }];
  assert.deepEqual(result.promptInput, expected);
  assert.ok(isObject(sent));
  assert.deepEqual(sent.input, [...expected, { type: "compaction_trigger" }]);
  assert.deepEqual(result.contextual, [true, false, false, false]);
  const retention = await prepareRetention(result.promptInput, new AbortController().signal, result);
  assert.deepEqual(buildReplacementHistory(retention, result.item), [visible, result.item]);
  assert.deepEqual(input, saved);
  assert.notEqual(result.promptInput[0], hidden);
});

test("awaits original image estimates before trimming and returns lookups usable after cloning", async () => {
  const image = originalImage;
  const output = { type: "custom_tool_call_output", call_id: "c", output: [image] };
  const registry = await testRegistry(providerInput([output]));
  let sent: unknown;
  const result = await requestRemoteCompaction({ ...request(registry), model: { ...model, contextWindow: 10 },
    fetch: async (input, init) => { sent = await new Request(input, init).json(); return response(); },
  });
  assert.equal(result.images.bytes(structuredClone(image)), 4);
  assert.deepEqual(result.promptInput, [output], "the original image fits when measured as one patch");
  assert.ok(isObject(sent));
  assert.deepEqual(sent.input, [output, { type: "compaction_trigger" }]);
  assert.deepEqual(result.contextual, [false]);
});

test("estimates prior checkpoint images and trims expanded history before the trigger", async () => {
  const marker = "checkpoint marker";
  const image = originalImage;
  const output = { type: "function_call_output", output: [{ type: "input_text", text: "x".repeat(800) }, image] };
  const opaque = { type: "compaction", encrypted_content: "prior" };
  const registry = await testRegistry(provider);
  let sent: unknown;
  const result = await requestRemoteCompaction({ ...request(registry), model: { ...model, contextWindow: 100 },
    context: { messages: [{ role: "user", content: marker, timestamp: 1 }] },
    priorCheckpoint: { identity: { provider: model.provider, api: model.api, modelId: model.id,
      baseUrl: model.baseUrl, endpoint: `${model.baseUrl}/responses` },
      marker, replacementHistory: [opaque, output] },
    fetch: async (input, init) => { sent = await new Request(input, init).json(); return response(); },
  });
  assert.deepEqual(result.promptInput, [opaque, { ...output, output: "Output exceeded the available model context and was truncated" }]);
  assert.equal(result.images.bytes(image), 4);
  assert.ok(isObject(sent));
  assert.deepEqual(sent.input, [...result.promptInput, { type: "compaction_trigger" }]);
  assert.deepEqual(result.contextual, [false, false]);
});

test("falls back to text classification when provider user counts differ from Pi origins", async () => {
  const hidden = { role: "user", content: [{ type: "input_text", text: "hidden without a marker" }] };
  const marked = { role: "user", content: [{ type: "input_text", text: "<environment_context>injected</environment_context>" }] };
  const registry = await testRegistry(providerInput([hidden, marked]));
  const result = await requestRemoteCompaction({ ...request(registry), userItemOrigins: ["context"],
    fetch: async () => response(),
  });
  assert.deepEqual(result.contextual, [false, false]);
  const prepared = await prepareRetention(result.promptInput, new AbortController().signal, result);
  assert.deepEqual(buildReplacementHistory(prepared, result.item), [hidden, result.item]);
});
