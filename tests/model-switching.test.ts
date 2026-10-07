// Exercise model changes and checkpoint replay through real Pi sessions.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { latestCheckpoint } from "../src/checkpoint.js";
import { createCodexCompactionExtension } from "../src/index.js";
import { isObject, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

const hasItem = (payload: JsonObject, type: string) => Array.isArray(payload.input) &&
  payload.input.some((item) => isObject(item) && item.type === type);

function configuredModel(base: Model<Api>, id: string, contextWindow: number, hash?: string): Model<Api> {
  const compat = { ...base.compat, supportsStore: false,
    remoteCompaction: { protocol: "v2", ...(hash ? { compactionModelHash: hash } : {}) } };
  return { ...base, id, name: id, contextWindow, maxTokens: 1_024, compat };
}

async function seed(fixture: Awaited<ReturnType<typeof sessionFixture>>) {
  for (let turn = 0; turn < 3; turn++) {
    await fixture.session.prompt(`Decision ${turn}: ${"Keep every approved interface and data handling requirement. ".repeat(160)}`);
  }
  await fixture.session.compact();
  const checkpoint = latestCheckpoint(fixture.session.sessionManager.getBranch());
  assert.ok(checkpoint);
  await fixture.session.prompt("Continue implementing the approved plan. ".repeat(80));
  return checkpoint;
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`${api} continues on a different backend without replaying opaque history`, async () => {
    const fixture = await sessionFixture({ api,
      extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      models: (base) => [configuredModel(base, base.id, 32_000),
        { ...configuredModel(base, "gpt-other-backend", 32_000), baseUrl: "https://different.example/v1" }],
    });
    try {
      const original = await seed(fixture);
      const saved = structuredClone(original.entry.details);
      const count = fixture.requests.length;
      await fixture.session.setModel(fixture.models[1]);
      assert.equal(fixture.requests.length, count);
      await fixture.session.prompt("Continue using the available recent context.");
      assert.equal(fixture.requests.length, count + 1);
      assert.ok(!hasItem(fixture.requests.at(-1)!.payload, "compaction"));
      assert.deepEqual(original.entry.details, saved);
      await fixture.session.setModel(fixture.model);
      await fixture.session.prompt("Continue on the original backend.");
      assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });

  test(`${api} does not gate same-backend replay on optional model hashes`, async () => {
    const fixture = await sessionFixture({ api,
      extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      models: (base) => [configuredModel(base, base.id, 32_000, "family-a"),
        configuredModel(base, "gpt-peer", 32_000, "family-b")],
    });
    try {
      await seed(fixture);
      await fixture.session.setModel(fixture.models[1]);
      await fixture.session.prompt("Continue the same task.");
      assert.equal(fixture.requests.at(-1)!.payload.model, fixture.models[1].id);
      assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });

  test(`${api} leaves smaller-model selection passive and compacts with the selected model`, async () => {
    const fixture = await sessionFixture({ api,
      extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      models: (base) => [configuredModel(base, base.id, 32_000), configuredModel(base, "gpt-small", 8_000)],
    });
    try {
      const original = await seed(fixture);
      const count = fixture.requests.length;
      await fixture.session.setModel(fixture.models[1]);
      assert.equal(fixture.requests.length, count, "Selection must not send preparatory compaction requests");
      assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch())?.entry.id, original.entry.id);
      await fixture.session.prompt("Continue on the smaller model. ".repeat(2_000));
      assert.equal(fixture.requests.length, count + 1, "Pi and the provider retain ordinary context-window handling");
      assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
      await fixture.session.compact();
      assert.equal(fixture.requests.at(-1)!.payload.model, fixture.models[1].id);
      assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction_trigger"));
      assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch())?.details.modelId, fixture.models[1].id);
      assert.equal(fixture.session.model?.id, fixture.models[1].id);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });

  test(`${api} retries a partial V2 stream without persisting its partial checkpoint`, async () => {
    let failNext = false;
    const fixture = await sessionFixture({ api,
      extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      settings: { retry: { enabled: false, provider: { maxRetries: 2, maxRetryDelayMs: 1 } } },
      respond: ({ payload }) => {
        if (!failNext || !hasItem(payload, "compaction_trigger")) return undefined;
        failNext = false;
        return new Response([
          { type: "response.created", response: { id: "fixture-interrupted" } },
          { type: "response.output_item.done", output_index: 0,
            item: { type: "compaction", encrypted_content: "discarded-attempt-opaque" } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const original = await seed(fixture);
      const saved = structuredClone(original.entry.details);
      const count = fixture.requests.length;
      failNext = true;
      await fixture.session.compact();
      const attempts = fixture.requests.slice(count);
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0].payload, attempts[1].payload);
      const successful = latestCheckpoint(fixture.session.sessionManager.getBranch());
      assert.ok(successful);
      assert.notEqual(successful.entry.id, original.entry.id);
      assert.doesNotMatch(JSON.stringify(successful.details), /discarded-attempt-opaque/);
      assert.equal(successful.details.replacementHistory.filter((item) => item.type === "compaction").length, 1);
      assert.deepEqual(original.entry.details, saved);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });

  for (const phase of ["preparation", "request", "retry", "response"] as const) {
    for (const backend of ["same", "different"] as const) {
      test(`${api} completes on the original model after a ${backend}-backend switch during ${phase}`, { timeout: 20_000 }, async () => {
        async function run(switchModel: boolean) {
          let changeSelection: (() => Promise<void>) | undefined;
          let attempts = 0;
          let switched = false;
          const change = async () => {
            if (!switchModel || switched) return;
            assert.ok(changeSelection);
            await changeSelection();
            switched = true;
          };
          const observe: ExtensionFactory = (pi) => {
            pi.on("before_provider_request", (event) => {
              assert.ok(isObject(event.payload));
              return { ...event.payload, prompt_cache_key: "switch-fixture", prompt_cache_retention: "24h",
                prompt_cache_options: { mode: "explicit", ttl: "30m" } };
            });
            pi.on("session_start", (_event, ctx) => {
              const registry = ctx.modelRegistry;
              const streamSimple = registry.streamSimple.bind(registry);
              registry.streamSimple = (model, context, options) => {
                const attempt = ++attempts;
                return streamSimple(model, context, { ...options, onPayload: async (payload, preparedModel) => {
                  if (phase === "preparation" || (phase === "retry" && attempt === 2)) await change();
                  return options?.onPayload?.(payload, preparedModel);
                }, onProviderStreamEvent: async (event, currentModel) => {
                  await options?.onProviderStreamEvent?.(event, currentModel);
                  if (phase === "response" && isObject(event) && event.type === "response.completed") await change();
                } });
              };
            });
          };
          let fetches = 0;
          const fixture = await sessionFixture({ api,
            extensions: (fetch) => [observe, createCodexCompactionExtension({ fetch })],
            models: (base) => [configuredModel(base, base.id, 32_000),
              { ...configuredModel(base, "gpt-peer", 32_000), ...(backend === "different" ? { baseUrl: "https://different.example/v1" } : {}) }],
            settings: { retry: { enabled: false, provider: { maxRetries: 1, maxRetryDelayMs: 1 } } },
            respond: async ({ payload }) => {
              if (!hasItem(payload, "compaction_trigger")) return undefined;
              fetches++;
              if (phase === "request") await change();
              return phase === "retry" && fetches === 1
                ? new Response("busy", { status: 503, headers: { "retry-after-ms": "1" } }) : undefined;
            },
          });
          try {
            changeSelection = async () => { await fixture.session.setModel(fixture.models[1]); };
            for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Task ${turn}: ${"Keep the approved decisions. ".repeat(80)}`);
            const ordinary = fixture.requests.at(-1)?.payload;
            assert.ok(ordinary && Array.isArray(ordinary.input));
            const count = fixture.requests.length;
            await fixture.session.compact();
            const checkpoint = latestCheckpoint(fixture.session.sessionManager.getBranch());
            assert.ok(checkpoint);
            assert.equal(checkpoint.details.modelId, fixture.model.id);
            assert.equal(checkpoint.details.baseUrl, fixture.model.baseUrl);
            assert.equal(checkpoint.details.provider, fixture.model.provider);
            assert.equal(fixture.session.model?.id, switchModel ? fixture.models[1].id : fixture.model.id);
            assert.equal(switched, switchModel);
            const requests = fixture.requests.slice(count);
            assert.equal(requests.length, phase === "retry" ? 2 : 1);
            for (const request of requests) {
              assert.equal(request.payload.model, fixture.model.id);
              assert.deepEqual(request.payload, requests[0].payload);
              assert.ok(Array.isArray(request.payload.input));
              assert.deepEqual(request.payload.input.slice(0, ordinary.input.length), ordinary.input);
              for (const field of ["instructions", "tools", "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"]) {
                assert.deepEqual(request.payload[field], ordinary[field]);
              }
            }
            assert.deepEqual(fixture.errors, []);
            const cwd = fixture.session.sessionManager.getCwd();
            return requests.map(({ payload, url }) => ({ url,
              body: JSON.stringify(payload).replaceAll(JSON.stringify(cwd).slice(1, -1), "<fixture-cwd>").replaceAll(cwd.replaceAll("\\", "/"), "<fixture-cwd>"),
            }));
          } finally { await fixture.close(); }
        }
        assert.deepEqual(await run(true), await run(false), "Model selection cannot alter the request body, endpoint, or attempt count");
      });
    }
  }
}

test("opaque replay preserves the model routing already applied to the ordinary payload", async () => {
  let reroute = false;
  const fixture = await sessionFixture({ extensions: (fetch) => [
    (pi) => pi.on("before_provider_request", (event) => reroute && isObject(event.payload)
      ? { ...event.payload, model: "gpt-routed" } : undefined), createCodexCompactionExtension({ fetch }),
  ] });
  try {
    await seed(fixture);
    const count = fixture.requests.length;
    reroute = true;
    await fixture.session.prompt("Continue from the saved history.");
    assert.equal(fixture.requests.length, count + 1);
    assert.equal(fixture.requests.at(-1)!.payload.model, "gpt-routed");
    assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("a context projection mismatch continues the ordinary request without opaque replay", async () => {
  let rewrite = false;
  const fixture = await sessionFixture({ extensions: (fetch) => [
    (pi) => pi.on("context", (event) => rewrite ? { messages: event.messages.map((message) =>
      message.role === "user" ? { ...message, content: "Rewritten context." } : message) } : undefined),
    createCodexCompactionExtension({ fetch }),
  ] });
  try {
    const original = await seed(fixture);
    const count = fixture.requests.length;
    rewrite = true;
    await fixture.session.prompt("Continue after the context rewrite.");
    assert.equal(fixture.requests.length, count + 1);
    assert.ok(!hasItem(fixture.requests.at(-1)!.payload, "compaction"));
    assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch())?.entry.id, original.entry.id);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
