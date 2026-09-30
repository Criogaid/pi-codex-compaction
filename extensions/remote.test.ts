import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { mergeRemoteCompactionHeader, requestRemoteCompaction } from "./remote.js";
import { testRegistry } from "./test-registry.test.js";

const provider = openaiProvider();
const model: Model<"openai-responses"> = {
  id: "fixture-model", name: "Fixture", api: "openai-responses", provider: provider.id,
  baseUrl: "https://gateway.example/v1", reasoning: true, input: ["text"],
  contextWindow: 100_000, maxTokens: 10_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsLongCacheRetention: true, ...{ remoteCompaction: { protocol: "v2" } } },
};
function response() {
  const item = { type: "compaction", encrypted_content: "opaque" };
  return new Response([
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-fixture", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 1 } } })}\n\n`,
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}
function request(modelRegistry: Awaited<ReturnType<typeof testRegistry>>) {
  return { modelRegistry, model, context: { messages: [{ role: "user" as const, content: "current", timestamp: 1 }] },
    reasoning: "high" as const, sessionId: "session", transport: "sse" as const,
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
  }), /different resolved provider identity/);
  assert.equal(sent, false);
});

test("accepts header-only auth and raw WebSocket events without requiring an HTTP body", async () => {
  const websocketModel = { ...model, api: "openai-codex-responses" as const };
  const eventProvider: Provider = {
    ...provider, getModels: () => [websocketModel],
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
          assert.equal(options?.transport, "websocket");
          await options?.onPayload?.({ model: preparedModel.id, input: [] }, preparedModel);
          const item = { type: "compaction", encrypted_content: "websocket-opaque" };
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
  const result = await requestRemoteCompaction({ ...request(registry), model: websocketModel, transport: "websocket",
    fetch: async () => { assert.fail("WebSocket provider must not require an HTTP request"); },
  });
  assert.equal(result.item.encrypted_content, "websocket-opaque");
});

for (const fault of ["endpoint", "method", "feature-header", "model"] as const) {
  test(`rejects provider ${fault} substitution before sending a request`, async () => {
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
    await assert.rejects(requestRemoteCompaction({ ...request(registry),
      fetch: async () => { sent = true; return response(); },
    }));
    assert.equal(sent, false);
  });
}
