// Exercise generic context transformations in both extension orders through real provider serialization.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createCodexCompactionExtension } from "../src/index.js";
import { isObject } from "../src/protocol.js";
import { fixtureImage, isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

const transientText = "Request-local inspection note.";
const transientMessage = (): AgentMessage => ({
  role: "custom", customType: "fixture-projection", content: transientText, display: false, timestamp: 0,
});

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const order of ["before", "after"] as const) {
    for (const change of ["reorder", "insert", "filter", "rewrite"] as const) {
      for (const blockImages of [false, true]) {
        for (const retry of [false, true]) {
          test(`${api} preserves ${change} projections ${order} capture, blockImages=${blockImages}, retry=${retry}`, { timeout: 20_000 }, async () => {
            let cycle = 0;
            let failNext = false;
            const transform: ExtensionFactory = (pi) => void pi.on("context", (event) => {
              const positions = event.messages.flatMap((message, index) => message.role === "user" &&
                (typeof message.content === "string" ? message.content.startsWith(`Task ${cycle}/`) :
                  message.content.some((part) => part.type === "text" && part.text.startsWith(`Task ${cycle}/`))) ? [index] : []);
              const [first, second] = positions;
              if (change === "insert") return { messages: [...event.messages, transientMessage()] };
              if (first === undefined) return;
              if (change === "filter") return { messages: event.messages.filter((_, index) => index !== first) };
              if (change === "rewrite") return { messages: event.messages.map((message, index) => index === first && message.role === "user"
                ? { ...message, content: typeof message.content === "string" ? `Projected ${message.content}` :
                  message.content.map((part) => part.type === "text" ? { ...part, text: `Projected ${part.text}` } : part), timestamp: 0 } : message) };
              if (second === undefined) return;
              const messages = [...event.messages];
              messages[first] = { ...event.messages[second], timestamp: 0 };
              messages[second] = { ...event.messages[first], timestamp: 0 };
              return { messages };
            });
            const wireSettings: ExtensionFactory = (pi) => void pi.on("before_provider_request", (event) => {
              assert.ok(isObject(event.payload));
              return { ...event.payload, prompt_cache_key: "fixture-projection-cache", prompt_cache_retention: "24h",
                prompt_cache_options: { ttl: "30m" }, parallel_tool_calls: false, text: { verbosity: "medium" } };
            });
            const fixture = await sessionFixture({ api,
              extensions: (fetch) => {
                const compactor = createCodexCompactionExtension({ fetch });
                return [wireSettings, ...(order === "before" ? [transform, compactor] : [compactor, transform])];
              },
              settings: { images: { blockImages }, retry: { enabled: false, provider: { maxRetries: retry ? 1 : 0, maxRetryDelayMs: 1 } } },
              respond: ({ payload }) => {
                if (!failNext || !Array.isArray(payload.input) || !payload.input.some((item) => isObject(item) && item.type === "compaction_trigger")) return;
                failNext = false;
                return new Response(JSON.stringify({ error: { code: "server_error", message: "Fixture temporary outage" } }),
                  { status: 503, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
              },
            });
            try {
              for (cycle = 0; cycle < 2; cycle++) {
                for (let turn = 0; turn < 3; turn++) {
                  await fixture.session.prompt(`Task ${cycle}/${turn}. ${"Keep the decisions. ".repeat(80)}`,
                    turn === 2 ? { images: [fixtureImage] } : undefined);
                }
                const ordinary = fixture.requests.at(-1)?.payload;
                assert.ok(ordinary && Array.isArray(ordinary.input));
                const reply = `Fixture reply ${fixture.requests.length}.`;
                const requestCount = fixture.requests.length;
                failNext = retry;
                await fixture.session.compact();
                const attempts = fixture.requests.slice(requestCount);
                assert.equal(attempts.length, retry ? 2 : 1);
                const compact = attempts[0].payload;
                assert.ok(Array.isArray(compact.input));
                for (const attempt of attempts) {
                  assert.deepEqual(attempt.payload, compact, "Retry preserves the complete prepared body");
                  assert.equal(attempt.headers.get("x-codex-beta-features"), "remote_compaction_v2");
                }
                assert.equal(compact.input.filter((item) => isObject(item) && item.type === "compaction_trigger").length, 1);
                assert.deepEqual(compact.input.slice(0, ordinary.input.length), ordinary.input);
                for (const field of ["tools", "instructions", "reasoning", "parallel_tool_calls", "text", "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"]) {
                  assert.deepEqual(compact[field], ordinary[field], `Preserve ${field}`);
                }
                for (const payload of [ordinary, compact]) {
                  assert.ok(Array.isArray(payload.input));
                  const hasImage = payload.input.some((item) => isObject(item) && Array.isArray(item.content) &&
                    item.content.some((part) => isObject(part) && part.type === "input_image"));
                  assert.equal(hasImage, !blockImages, "The image policy is exercised in ordinary and V2 requests");
                  assert.equal(JSON.stringify(payload.input).includes(fixtureImage.data), !blockImages);
                }
                assert.equal(compact.input.filter((item) => isObject(item) && item.type === "compaction").length, cycle);
                assert.equal(compact.input.slice(ordinary.input.length).filter((item) => JSON.stringify(item).includes(reply)).length, 1);
              }
              assert.deepEqual(fixture.errors, []);
            } finally {
              await fixture.close();
            }
          });
        }
      }
    }

    test(`${api} does not duplicate a transient projection persisted after the request with capture ${order}`, { timeout: 20_000 }, async () => {
      const transform: ExtensionFactory = (pi) => void pi.on("context", (event) => ({ messages: [...event.messages, transientMessage()] }));
      const compactor = createCodexCompactionExtension();
      const fixture = await sessionFixture({ api, extensions: order === "before" ? [transform, compactor] : [compactor, transform] });
      try {
        for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Preserve the current task. ".repeat(80)}`);
        fixture.session.sessionManager.appendCustomMessageEntry("fixture-projection", transientText, false, { persisted: true });
        await fixture.session.compact();
        const compact = fixture.requests.at(-1)?.payload;
        assert.ok(compact && Array.isArray(compact.input));
        assert.equal(compact.input.filter((item) => isObject(item) && item.type === "compaction_trigger").length, 1);
        assert.equal(compact.input.filter((item) => JSON.stringify(item).includes(transientText)).length, 1);
        assert.deepEqual(fixture.errors, []);
      } finally {
        await fixture.close();
      }
    });
  }
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`${api} does not bind a request projection that failed checkpoint replay`, { timeout: 20_000 }, async () => {
    let rewriteRetained = false;
    const transform: ExtensionFactory = (pi) => {
      pi.on("context", (event) => {
        if (!rewriteRetained) return;
        return { messages: event.messages.map((message) => message.role === "user"
          ? { ...message, content: "Changed request-local retained content" } : message) };
      });
    };
    const fixture = await sessionFixture({ api, extensions: [transform, createCodexCompactionExtension()] });
    try {
      for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Keep the task. ".repeat(80)}`);
      await fixture.session.compact();
      rewriteRetained = true;
      for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Continue ${turn}. ${"Retain these decisions. ".repeat(80)}`);
      const ordinary = fixture.requests.at(-1)?.payload;
      assert.ok(ordinary && Array.isArray(ordinary.input));
      assert.ok(!ordinary.input.some((item) => isObject(item) && item.type === "compaction"));
      await fixture.session.compact();
      const compact = fixture.requests.at(-1)?.payload;
      assert.ok(compact && Array.isArray(compact.input));
      assert.equal(compact.input.filter((item) => isObject(item) && item.type === "compaction_trigger").length, 1);
      assert.equal(compact.input.filter((item) => isObject(item) && item.type === "compaction").length, 1);
      assert.ok(!JSON.stringify(compact.input).includes("Changed request-local retained content"));
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
}
