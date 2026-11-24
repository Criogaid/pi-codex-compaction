import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import codexCompaction from "../src/index.js";
import { isObject, isObjectArray } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

const ordinaryKey = "fixture-ordinary-cache";
const warmKey = "fixture-prewarm-cache";
const contextWindow = 32_000;
const reserveTokens = 1_024;
const background = "Preserve the agreed implementation constraints. ".repeat(60);
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const inputTokensByReason = {
  manual: 16_000,
  threshold: contextWindow - reserveTokens / 2,
  overflow: contextWindow + 1,
} satisfies Record<SessionBeforeCompactEvent["reason"], number>;

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const [reason, inputTokens] of Object.entries(inputTokensByReason)) {
    test(`${api} ${reason} compaction keeps the ordinary cache key after a streaming prewarm`, async (t) => {
      let targetTurn = false;
      let assistantEnded = false;
      let warming = false;
      let warmRecorded = false;
      const compactionStarts: Pick<SessionBeforeCompactEvent, "reason" | "willRetry">[] = [];
      const fixture = await sessionFixture({
        api,
        models: (base) => [{
          ...base, contextWindow, promptCache: { short: 30, long: 30 },
          cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 0 },
        }],
        settings: { cacheWarming: "streaming", compaction: { enabled: reason !== "manual", reserveTokens, keepRecentTokens: 128 } },
        ordinaryInputTokens: () => targetTurn && !warming ? inputTokens : undefined,
        extensions: [
          (pi) => {
            pi.on("before_provider_request", ({ payload }) => {
              assert.ok(isObject(payload));
              return { ...payload, prompt_cache_key: warming ? warmKey : ordinaryKey };
            });
            pi.on("message_end", ({ message }) => {
              if (targetTurn && message.role === "assistant") assistantEnded = true;
            });
            pi.on("turn_end", async ({ message }) => {
              if (!targetTurn) return;
              assert.ok(assistantEnded);
              assert.ok(message.role === "assistant" && message.stopReason === "stop");
              assert.equal(message.usage.input, inputTokens);
              const status = fixture.session.cacheWarmingStatus;
              assert.equal(status?.state, "scheduled");
              assert.ok(status.nextWarmAt !== undefined);

              const { promise, resolve, reject } = Promise.withResolvers<void>();
              const unsubscribe = fixture.session.subscribe((event) => {
                if (event.type === "entry_appended" && event.entry.type === "usage" && event.entry.kind === "cache_warm") resolve();
              });
              const deadline = realSetTimeout(() => reject(new Error("Pi did not record cache_warm usage")), 3_000);
              warming = true;
              try {
                // Keep turn_end open so the streamer can refresh before Pi settles the run.
                t.mock.timers.tick(status.nextWarmAt - Date.now());
                await promise;
                warmRecorded = true;
              } finally {
                warming = false;
                realClearTimeout(deadline);
                unsubscribe();
              }
            });
            pi.on("session_before_compact", (event) => {
              assert.ok(warmRecorded, "The cache warm completed before compaction began");
              compactionStarts.push({ reason: event.reason, willRetry: event.willRetry });
            });
          },
          codexCompaction,
        ],
      });
      t.after(() => fixture.close());

      await fixture.session.prompt(background);
      await fixture.session.prompt(background);
      assert.equal(fixture.requests.length, 2);
      assert.deepEqual(compactionStarts, []);

      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
      targetTurn = true;
      await fixture.session.prompt("Summarize the decisions for the handoff.");
      targetTurn = false;
      if (reason === "manual") await fixture.session.compact();

      assert.deepEqual(fixture.errors, []);
      assert.ok(warmRecorded);
      assert.deepEqual(compactionStarts, [{ reason, willRetry: false }]);
      const [ordinary, prewarm, v2] = fixture.requests.slice(2).map(({ payload }) => payload);
      assert.equal(fixture.requests.length, 5);
      assert.equal(ordinary.prompt_cache_key, ordinaryKey);
      assert.equal(prewarm.prompt_cache_key, warmKey);
      assert.ok(isObjectArray(v2.input));
      assert.deepEqual(v2.input.at(-1), { type: "compaction_trigger" });

      const branch = fixture.session.sessionManager.getBranch();
      const checkpoint = branch.findLast((entry) => entry.type === "compaction");
      assert.ok(checkpoint?.type === "compaction" && parseCheckpointDetails(checkpoint.details));
      await fixture.session.prompt("Continue with the next task.");
      assert.equal(fixture.requests.length, 6);
      const nextOrdinary = fixture.requests[5].payload;
      assert.ok(fixture.session.sessionManager.getBranch().some((entry) => entry.id === checkpoint.id));
      assert.equal(nextOrdinary.prompt_cache_key, ordinary.prompt_cache_key);
      assert.deepEqual(fixture.errors, []);
      assert.equal(v2.prompt_cache_key, ordinary.prompt_cache_key, "V2 must keep the ordinary request's cache key");
    });
  }
}
