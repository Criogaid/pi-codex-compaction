import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
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
    endpoint: `${model.baseUrl}/responses`, reasoning: "high" as const, sessionId: "session", transport: "sse" as const,
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
  await requestRemoteCompaction({ ...request(registry), endpoint,
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
