// Exercise model migration, request cancellation, and checkpoint ownership through real Pi sessions.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { latestCheckpoint } from "../src/checkpoint.js";
import { estimateImages } from "../src/image-budget.js";
import { createCodexCompactionExtension } from "../src/index.js";
import { estimateModelInput, modelInputBudget } from "../src/model-budget.js";
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

async function seed(fixture: Awaited<ReturnType<typeof sessionFixture>>, large = false) {
  for (let turn = 0; turn < 3; turn++) {
    await fixture.session.prompt(`Decision ${turn}: ${"Keep every approved interface and data handling requirement. ".repeat(large ? 160 : 50)}`);
  }
  await fixture.session.compact();
  const checkpoint = latestCheckpoint(fixture.session.sessionManager.getBranch());
  assert.ok(checkpoint);
  await fixture.session.prompt("Continue implementing the approved plan. ".repeat(80));
  return checkpoint;
}

function compactionResponse(encrypted_content: string): Response {
  const item = { type: "compaction", encrypted_content };
  return new Response([
    { type: "response.created", response: { id: "fixture-custom" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fixture-custom", status: "completed", output: [item],
      usage: { input_tokens: 777, output_tokens: 31, total_tokens: 808 } } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const mismatch of ["hash", "same-id hash", "backend"] as const) {
    test(`${api} cancels ${mismatch} replay before network and restores the original checkpoint`, { timeout: 25_000 }, async () => {
      const fixture = await sessionFixture({ api,
        extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
        models: (base) => [configuredModel(base, base.id, 32_000, "hash-a"),
          { ...configuredModel(base, mismatch === "same-id hash" ? base.id : "gpt-fixture-target", 32_000,
            mismatch === "backend" ? "hash-a" : "hash-b"),
            ...(mismatch === "backend" ? { baseUrl: "https://different.example/v1" } : {}) }],
      });
      try {
        const original = await seed(fixture);
        const saved = structuredClone(original.entry.details);
        const count = fixture.requests.length;
        await fixture.session.setModel(fixture.models[1]);
        await fixture.session.prompt("Continue using the older decisions.");
        assert.equal(fixture.requests.length, count, "Incompatible opaque history must never reach fetch");
        assert.deepEqual(original.entry.details, saved);
        assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch())?.entry.id, original.entry.id);
        assert.ok(fixture.errors.some((error) => /incompatible.*backend|backend or compaction hash/i.test(error)));

        await fixture.session.setModel(fixture.model);
        await fixture.session.prompt("Continue on the original model.");
        assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
      } finally { await fixture.close(); }
    });
  }

  test(`${api} preserves unknown same-backend compatibility without inventing a hash`, { timeout: 25_000 }, async () => {
    const fixture = await sessionFixture({ api,
      extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      models: (base) => [configuredModel(base, base.id, 32_000), configuredModel(base, "gpt-fixture-peer", 32_000)],
    });
    try {
      const original = await seed(fixture);
      assert.equal(original.details.compactionModelHash, undefined);
      await fixture.session.setModel(fixture.models[1]);
      await fixture.session.prompt("Continue the same task.");
      assert.equal(fixture.requests.at(-1)!.payload.model, fixture.models[1].id);
      assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
      assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch())?.details.modelId, fixture.model.id);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });

  for (const hash of ["shared", undefined] as const) {
  test(`${api} prepares a smaller window with the original model and keeps producer metadata (hash=${hash})`, { timeout: 25_000 }, async () => {
    const fixture = await sessionFixture({ api,
      extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      models: (base) => [configuredModel(base, base.id, 32_000, hash), configuredModel(base, "gpt-fixture-small", 8_000, hash)],
    });
    try {
      const original = await seed(fixture, true);
      const oldHistory = JSON.stringify(original.details.replacementHistory);
      const count = fixture.requests.length;
      await fixture.session.setModel(fixture.models[1]);
      assert.equal(fixture.session.model?.id, fixture.models[1].id, "Preparation must leave the selected chat model unchanged");
      const preparing = fixture.requests.slice(count);
      assert.equal(preparing.length, 1);
      assert.equal(preparing[0].payload.model, fixture.model.id);
      assert.ok(hasItem(preparing[0].payload, "compaction_trigger"));
      assert.ok(hasItem(preparing[0].payload, "compaction"));
      const prepared = latestCheckpoint(fixture.session.sessionManager.getBranch());
      assert.ok(prepared);
      assert.notEqual(prepared.entry.id, original.entry.id);
      assert.equal(prepared.details.modelId, fixture.model.id);
      assert.equal(prepared.details.modelContextWindow, 32_000);
      assert.equal(prepared.details.compactionModelHash, hash);
      assert.ok(JSON.stringify(prepared.details.replacementHistory).length < oldHistory.length);
      assert.equal(JSON.stringify(original.details.replacementHistory), oldHistory);

      await fixture.session.prompt("Continue after preparing the smaller model.");
      const payload = fixture.requests.at(-1)!.payload;
      assert.equal(payload.model, fixture.models[1].id);
      assert.ok(hasItem(payload, "compaction"));
      const images = await estimateImages((payload.input as JsonObject[]), new AbortController().signal);
      assert.ok(estimateModelInput(payload, images) <= modelInputBudget(fixture.models[1], 1_024));
      const identity = structuredClone(prepared.details);
      await fixture.reopen();
      assert.deepEqual(latestCheckpoint(fixture.session.sessionManager.getBranch())?.details, identity);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
  }

  test(`${api} retries a partial V2 stream without persisting its partial checkpoint`, { timeout: 25_000 }, async () => {
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
      assert.ok(attempts.every(({ payload }) => hasItem(payload, "compaction_trigger")));
      const successful = latestCheckpoint(fixture.session.sessionManager.getBranch());
      assert.ok(successful);
      assert.notEqual(successful.entry.id, original.entry.id);
      assert.doesNotMatch(JSON.stringify(successful.details), /discarded-attempt-opaque/);
      assert.equal(successful.details.replacementHistory.filter((item) => item.type === "compaction").length, 1);
      assert.deepEqual(original.entry.details, saved);
      assert.equal(fixture.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 2);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });

  test(`${api} rejects oversized preparation output without replacing the previous checkpoint`, { timeout: 25_000 }, async () => {
    let oversized = false;
    const fixture = await sessionFixture({ api,
      extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      models: (base) => [configuredModel(base, base.id, 32_000, "shared"), configuredModel(base, "gpt-fixture-small", 8_000, "shared")],
      respond: ({ payload }) => oversized && hasItem(payload, "compaction_trigger") ? compactionResponse("x".repeat(80_000)) : undefined,
    });
    try {
      const original = await seed(fixture, true);
      const count = fixture.requests.length;
      oversized = true;
      await fixture.session.setModel(fixture.models[1]);
      assert.equal(fixture.requests.length, count + 1);
      assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction_trigger"), "No native fallback request is allowed");
      assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch())?.entry.id, original.entry.id);
      await fixture.session.prompt("Continue with the small window.");
      assert.equal(fixture.requests.length, count + 1, "The oversized expanded old checkpoint must remain blocked");
      assert.ok(fixture.errors.some((error) => /estimated input budget/.test(error)));
      oversized = false;
      await fixture.session.setModel(fixture.model);
      await fixture.session.prompt("Resume the preserved checkpoint on its original model.");
      assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
    } finally { await fixture.close(); }
  });

  test(`${api} discards a compaction result when the selected model changes during its stream`, { timeout: 25_000 }, async () => {
    let switchDuringCompaction = false;
    const fixture = await sessionFixture({ api,
      extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      models: (base) => [configuredModel(base, base.id, 32_000, "shared"), configuredModel(base, "gpt-fixture-peer", 32_000, "shared")],
      respond: async ({ payload }) => {
        if (switchDuringCompaction && hasItem(payload, "compaction_trigger")) {
          switchDuringCompaction = false;
          await fixture.session.setModel(fixture.models[1]);
        }
        return undefined;
      },
    });
    try {
      const original = await seed(fixture);
      switchDuringCompaction = true;
      const count = fixture.requests.length;
      await assert.rejects(fixture.session.compact(), /Compaction cancelled/);
      assert.equal(fixture.requests.length, count + 1);
      assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch())?.entry.id, original.entry.id);
      assert.equal(fixture.session.model?.id, fixture.models[1].id);
      await fixture.session.prompt("Continue from the unchanged checkpoint.");
      assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
}

test("the final expanded payload guard includes new wire instructions after smaller-model preparation", { timeout: 25_000 }, async () => {
  let enlarged = false;
  const fixture = await sessionFixture({
    extensions: (fetch) => [(pi) => pi.on("before_provider_request", (event) => enlarged && isObject(event.payload)
      ? { ...event.payload, instructions: "unbounded instructions ".repeat(4_000) } : undefined), createCodexCompactionExtension({ fetch })],
    models: (base) => [configuredModel(base, base.id, 32_000, "shared"), configuredModel(base, "gpt-fixture-small", 8_000, "shared")],
  });
  try {
    await seed(fixture, true);
    await fixture.session.setModel(fixture.models[1]);
    const prepared = latestCheckpoint(fixture.session.sessionManager.getBranch());
    const count = fixture.requests.length;
    enlarged = true;
    await fixture.session.prompt("Continue the prepared task.");
    assert.equal(fixture.requests.length, count);
    assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch())?.entry.id, prepared?.entry.id);
    assert.ok(fixture.errors.some((error) => /estimated input budget/.test(error)));
  } finally { await fixture.close(); }
});

test("opaque replay rejects a wire model differing from the selected model before fetch", { timeout: 25_000 }, async () => {
  let reroute = false;
  const fixture = await sessionFixture({ extensions: (fetch) => [
    (pi) => pi.on("before_provider_request", (event) => reroute && isObject(event.payload)
      ? { ...event.payload, model: "gpt-unverified-route" } : undefined), createCodexCompactionExtension({ fetch }),
  ] });
  try {
    const original = await seed(fixture);
    const count = fixture.requests.length;
    reroute = true;
    await fixture.session.prompt("Continue from the saved history.");
    assert.equal(fixture.requests.length, count);
    assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch())?.entry.id, original.entry.id);
    assert.ok(fixture.errors.some((error) => /routes to a different model/.test(error)));
  } finally { await fixture.close(); }
});
