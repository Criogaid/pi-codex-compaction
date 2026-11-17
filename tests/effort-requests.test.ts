// Exercise effort rewrites through Pi's real request hooks and V2 transport.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { applyCodexEffortUpdates } from "../src/effort-updates.js";
import { createCodexCompactionExtension } from "../src/index.js";
import { isObject, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

const effortUpdate = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });

// The pinned Pi adapter predates native effort updates; insert its newer serialization before hooks.
const simulateEffort: ExtensionFactory = (pi) => {
  pi.on("session_start", (_event, ctx) => {
    const registry = ctx.modelRegistry;
    const streamSimple = registry.streamSimple.bind(registry);
    registry.streamSimple = (model, context, options) => streamSimple(model, context, {
      ...options,
      onPayload: async (payload, preparedModel) => {
        assert.ok(isObject(payload) && Array.isArray(payload.input) && payload.input.every(isObject));
        const input = payload.input.flatMap((item) => item.role === "assistant"
          ? [effortUpdate("low"), item] : [item]);
        const dense = { ...payload, input: [...input, effortUpdate(options?.reasoning ?? "low")] };
        return await options?.onPayload?.(dense, preparedModel) ?? dense;
      },
    });
  });
};

// Match the separate package's hook contract without a dependency on a neighboring checkout.
const reasoningHook: ExtensionFactory = (pi) => {
  pi.on("before_provider_request", (event) => {
    const rewritten = applyCodexEffortUpdates(event.payload);
    return rewritten === event.payload ? undefined : rewritten;
  });
};

function normalized(payloads: readonly JsonObject[], cwd: string, sessionId: string): unknown {
  return JSON.parse(JSON.stringify(payloads)
    .replaceAll(JSON.stringify(cwd).slice(1, -1), "<fixture-cwd>")
    .replaceAll(cwd.replaceAll("\\", "/"), "<fixture-cwd>")
    .replaceAll(sessionId, "<fixture-session>"));
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`${api} sends identical sparse ordinary and V2 requests with either effort-hook load order`, { timeout: 30_000 }, async () => {
    async function run(order: "alone" | "before" | "after") {
      const fixture = await sessionFixture({ api, extensions: (fetch) => {
        const compactor = createCodexCompactionExtension({ fetch });
        return [simulateEffort, ...(order === "alone" ? [compactor]
          : order === "before" ? [reasoningHook, compactor] : [compactor, reasoningHook])];
      } });
      try {
        for (let turn = 0; turn < 3; turn++) {
          await fixture.session.prompt(`Decision ${turn}: ${"Keep the approved requirements. ".repeat(80)}`);
        }
        await fixture.session.compact();
        fixture.session.setThinkingLevel("high");
        await fixture.session.prompt("Continue with the saved checkpoint. ".repeat(80));
        const ordinary = fixture.requests.at(-1)?.payload;
        assert.ok(ordinary && Array.isArray(ordinary.input) && ordinary.input.every(isObject));
        assert.equal(ordinary.input.filter((item) => item.type === "compaction").length, 1);
        assert.ok(isObject(ordinary.reasoning));
        assert.equal(ordinary.reasoning.effort, "high");
        assert.equal(ordinary.input.filter((item) => item.type === "configuration_update").length, 0,
          "The first turn after compaction pins the baseline without an update");
        await fixture.session.compact();
        const compact = fixture.requests.at(-1)?.payload;
        assert.ok(compact && Array.isArray(compact.input) && compact.input.every(isObject));
        assert.deepEqual(compact.input.at(-1), { type: "compaction_trigger" });
        assert.notEqual(compact.input.at(-2)?.type, "configuration_update");
        for (const { payload } of fixture.requests) {
          assert.ok(Array.isArray(payload.input));
          for (let index = 1; index < payload.input.length; index++) {
            const previous: unknown = payload.input[index - 1];
            const current: unknown = payload.input[index];
            assert.ok(!isObject(previous) || previous.type !== "configuration_update" ||
              !isObject(current) || current.type !== "configuration_update");
          }
        }
        assert.deepEqual(fixture.errors, []);
        return normalized(fixture.requests.map(({ payload }) => payload), fixture.session.sessionManager.getCwd(),
          fixture.session.sessionManager.getSessionId());
      } finally {
        await fixture.close();
      }
    }
    const alone = await run("alone");
    assert.deepEqual(await run("before"), alone);
    assert.deepEqual(await run("after"), alone);
  });
}
