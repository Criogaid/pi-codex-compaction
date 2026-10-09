// Exercise generic context transformations in both extension orders through real provider serialization.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createCodexCompactionExtension } from "../src/index.js";
import { isObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

const transientText = "Request-local inspection note.";
const transientMessage = (): AgentMessage => ({
  role: "custom", customType: "fixture-projection", content: transientText, display: false, timestamp: 0,
});

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const order of ["before", "after"] as const) {
    for (const change of ["reorder", "insert", "filter", "rewrite"] as const) {
      test(`${api} preserves ${change} projections ${order} compaction capture across checkpoints`, { timeout: 20_000 }, async () => {
        let cycle = 0;
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
        const compactor = createCodexCompactionExtension();
        const fixture = await sessionFixture({ api,
          extensions: [wireSettings, ...(order === "before" ? [transform, compactor] : [compactor, transform])] });
        try {
          for (cycle = 0; cycle < 2; cycle++) {
            for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Task ${cycle}/${turn}. ${"Keep the decisions. ".repeat(80)}`);
            const ordinary = fixture.requests.at(-1)?.payload;
            assert.ok(ordinary && Array.isArray(ordinary.input));
            const reply = `Fixture reply ${fixture.requests.length}.`;
            await fixture.session.compact();
            const compact = fixture.requests.at(-1)?.payload;
            assert.ok(compact && Array.isArray(compact.input));
            assert.equal(compact.input.filter((item) => isObject(item) && item.type === "compaction_trigger").length, 1);
            assert.deepEqual(compact.input.slice(0, ordinary.input.length), ordinary.input);
            for (const field of ["tools", "instructions", "reasoning", "parallel_tool_calls", "text", "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"]) {
              assert.deepEqual(compact[field], ordinary[field], `Preserve ${field}`);
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
