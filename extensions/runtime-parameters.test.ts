// Compare compaction with Pi's real provider adapters without making network requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import type { Context, Model, Provider } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { requestRemoteCompaction } from "./remote.js";
import { testRegistry } from "./test-registry.test.js";

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
      const endpoint = api === "openai-responses"
        ? "https://gateway.example/v1/responses"
        : "https://gateway.example/v1/codex/responses";
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
      await requestRemoteCompaction({
        modelRegistry, model, context, endpoint, reasoning, sessionId, transport: "sse",
        signal: new AbortController().signal,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const bytes = Buffer.from(await request.arrayBuffer());
          const json = request.headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(bytes).toString("utf8")
            : bytes.toString("utf8");
          compactPayload = JSON.parse(json);
          compactHeaders = request.headers;
          return response();
        },
      });
      assert.ok(ordinaryPayload && typeof ordinaryPayload === "object");
      const expected = ordinaryPayload as { input: unknown[] };
      assert.deepEqual(compactPayload, {
        ...expected, input: [...expected.input, { type: "compaction_trigger" }],
      });
      for (const header of ["session_id", "x-client-request-id", "chatgpt-account-id"]) {
        assert.equal(compactHeaders?.get(header), ordinaryHeaders?.get(header), header);
      }
    });
  }
}
