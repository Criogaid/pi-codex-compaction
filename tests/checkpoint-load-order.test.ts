// Require checkpoint replay and request reuse to be independent of extension load order.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import codexCompaction from "../src/index.js";
import { checkpointMarker, parseCheckpointDetails } from "../src/checkpoint.js";
import { hasCheckpointMarker, isObject, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

const annotation = "Request-local note after the compaction boundary.";

// Generic request-local edits that reach checkpoint-retained messages when they run first.
const transforms = {
  // A redaction or speaker-label extension rewrites every user text part.
  tag: (messages) => messages.map((message) => message.role !== "user" ? message : {
    ...message,
    content: typeof message.content === "string" ? `[tagged] ${message.content}` :
      message.content.map((part) => part.type === "text" ? { ...part, text: `[tagged] ${part.text}` } : part),
  }),
  // A pruning extension drops assistant turns from the request.
  prune: (messages) => messages.filter((message) => message.role !== "assistant"),
  // A goal or memory extension annotates the compaction boundary.
  annotate: (messages) => {
    const index = messages.findIndex((message) => message.role === "compactionSummary");
    const note: AgentMessage = { role: "custom", customType: "fixture-annotation", content: annotation, display: false, timestamp: 0 };
    return [...messages.slice(0, index + 1), note, ...messages.slice(index + 1)];
  },
} satisfies Record<string, (messages: AgentMessage[]) => AgentMessage[]>;

// Each fixture runs in its own temporary directory, which Pi includes in the system prompt.
function withoutFixtureDirectory(input: readonly JsonObject[]): unknown {
  return JSON.parse(JSON.stringify(input).replace(/pi-compaction-session-[^/\\"]+/g, "pi-compaction-session"));
}

function countType(input: readonly unknown[], type: string): number {
  return input.filter((item) => isObject(item) && item.type === type).length;
}

async function run(
  api: "openai-responses" | "openai-codex-responses",
  transform: (messages: AgentMessage[]) => AgentMessage[],
  order: "before" | "after",
): Promise<{ readonly ordinary: JsonObject[]; readonly compact: JsonObject[] }> {
  const hook: ExtensionFactory = (pi) => void pi.on("context", (event) => ({ messages: transform(event.messages) }));
  const fixture = await sessionFixture({ api, extensions: order === "before" ? [hook, codexCompaction] : [codexCompaction, hook] });
  try {
    for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Keep the decisions. ".repeat(80)}`);
    await fixture.session.compact();
    await fixture.session.prompt(`Continue. ${"Use the compacted history. ".repeat(40)}`);
    const ordinary = fixture.requests.at(-1)?.payload;
    assert.ok(ordinary && Array.isArray(ordinary.input) && ordinary.input.every(isObject));
    const text = JSON.stringify(ordinary.input);
    assert.equal(countType(ordinary.input, "compaction"), 1, `Replay the opaque checkpoint with the hook ${order} the compactor`);
    assert.ok(!text.includes("PI_CODEX_REMOTE_CHECKPOINT"), `Never send the private checkpoint marker with the hook ${order} the compactor`);
    assert.ok(!text.includes("Codex Remote Compaction V2 (checkpoint"), `Never send the fallback summary with the hook ${order} the compactor`);

    await fixture.session.compact();
    const compact = fixture.requests.at(-1)?.payload;
    assert.ok(compact && Array.isArray(compact.input) && compact.input.every(isObject));
    assert.equal(countType(compact.input, "compaction_trigger"), 1);
    assert.equal(countType(compact.input, "compaction"), 1, `Replay the prior checkpoint once in V2 with the hook ${order} the compactor`);
    assert.deepEqual(compact.input.slice(0, ordinary.input.length), ordinary.input,
      `Keep the ordinary request prefix in V2 with the hook ${order} the compactor`);
    assert.deepEqual(fixture.errors, []);
    return { ordinary: ordinary.input, compact: compact.input };
  } finally {
    await fixture.close();
  }
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const [name, transform] of Object.entries(transforms)) {
    test(`${api} replays a checkpoint identically whichever side a ${name} context hook loads on`,
      { timeout: 30_000 }, async () => {
        const before = await run(api, transform, "before");
        const after = await run(api, transform, "after");
        assert.deepEqual(withoutFixtureDirectory(before.ordinary), withoutFixtureDirectory(after.ordinary),
          "Load order must not change the ordinary request");
        assert.deepEqual(withoutFixtureDirectory(before.compact), withoutFixtureDirectory(after.compact),
          "Load order must not change the V2 request");
      });
  }

  test(`${api} keeps cache policy in V2 with an incremental hook on either side`, { timeout: 30_000 }, async () => {
    const cachePolicy: ExtensionFactory = (pi) => void pi.on("before_provider_request", ({ payload }) => {
      assert.ok(isObject(payload));
      return { ...payload, prompt_cache_key: "fixture-incremental-cache", prompt_cache_options: { ttl: "30m" } };
    });
    const continuation = `Send this turn using the previous response ID. ${"Use the compacted history. ".repeat(40)}`;
    let incremental = false;
    const referenceHistory: ExtensionFactory = (pi) => void pi.on("before_provider_request", ({ payload }) => {
      if (!incremental) return;
      assert.ok(isObject(payload) && Array.isArray(payload.input));
      const input = payload.input.filter((item) => isObject(item) && item.role === "user" &&
        JSON.stringify(item).includes(continuation));
      assert.equal(input.length, 1);
      return { ...payload, input, previous_response_id: "fixture-response-anchor" };
    });

    for (const order of ["after", "before"] as const) {
      const fixture = await sessionFixture({ api, extensions: [cachePolicy,
        ...(order === "before" ? [referenceHistory, codexCompaction] : [codexCompaction, referenceHistory])] });
      try {
        incremental = false;
        for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Keep the decisions. ".repeat(80)}`);
        const { details } = await fixture.session.compact();
        assert.ok(parseCheckpointDetails(details));

        incremental = true;
        await fixture.session.prompt(continuation);
        const ordinary = fixture.requests.at(-1)?.payload;
        assert.ok(ordinary && Array.isArray(ordinary.input));
        assert.equal(ordinary.previous_response_id, "fixture-response-anchor");
        assert.equal(ordinary.input.length, 1);
        assert.equal(countType(ordinary.input, "compaction"), 0);

        await fixture.session.compact();
        const compact = fixture.requests.at(-1)?.payload;
        assert.ok(compact && Array.isArray(compact.input));
        assert.equal(countType(compact.input, "compaction_trigger"), 1);
        assert.equal(countType(compact.input, "compaction"), 1);
        assert.equal(compact.previous_response_id, undefined);
        assert.ok(JSON.stringify(compact.input).includes(continuation));
        assert.deepEqual(fixture.errors, []);
        assert.deepEqual(
          [compact.prompt_cache_key, compact.prompt_cache_options],
          [ordinary.prompt_cache_key, ordinary.prompt_cache_options],
          `V2 preserves the ordinary cache policy with the incremental hook ${order} the compactor`,
        );
      } finally {
        await fixture.close();
      }
    }
  });

  test(`${api} replays a checkpoint when recording a provider snapshot fails`, { timeout: 20_000 }, async () => {
    let failRecording = false;
    const proxyField: ExtensionFactory = (pi) => void pi.on("before_provider_request", ({ payload }) => {
      if (!failRecording) return;
      assert.ok(isObject(payload));
      return { ...payload, reasoning: new Proxy({ effort: "low" }, {}) };
    });
    const fixture = await sessionFixture({ api, extensions: [proxyField, codexCompaction] });
    try {
      for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Keep the decisions. ".repeat(80)}`);
      const { details } = await fixture.session.compact();
      assert.ok(parseCheckpointDetails(details));
      failRecording = true;
      for (let turn = 0; turn < 2; turn++) {
        await fixture.session.prompt(`Continue ${turn}.`);
        const payload = fixture.requests.at(-1)?.payload;
        assert.ok(payload && Array.isArray(payload.input));
        assert.equal(countType(payload.input, "compaction"), 1);
        assert.ok(!JSON.stringify(payload.input).includes("PI_CODEX_REMOTE_CHECKPOINT"));
        assert.deepEqual(payload.reasoning, { effort: "low" });
      }
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });

  test(`${api} preserves replay errors and drops the previous wire snapshot when recording fails`, { timeout: 20_000 }, async () => {
    const wireOnly = "Only present in the previous request payload.";
    let marker: string | undefined;
    let failRecording = false;
    const editRequest: ExtensionFactory = (pi) => {
      pi.on("context", (event) => failRecording ? { messages: transforms.annotate(event.messages) } : undefined);
      pi.on("before_provider_request", ({ payload }) => {
        const activeMarker = marker;
        if (activeMarker === undefined) return;
        assert.ok(isObject(payload) && Array.isArray(payload.input));
        if (!failRecording) {
          return { ...payload, input: [...payload.input,
            { type: "message", role: "user", content: [{ type: "input_text", text: wireOnly }] }] };
        }
        const checkpoint = payload.input.find((item) => hasCheckpointMarker({ input: [item] }, activeMarker));
        assert.ok(checkpoint);
        return { ...payload, input: [...payload.input, checkpoint],
          reasoning: new Proxy({ effort: "low" }, {}) };
      });
    };
    const fixture = await sessionFixture({ api, extensions: [editRequest, codexCompaction] });
    try {
      for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Keep the decisions. ".repeat(80)}`);
      const { details } = await fixture.session.compact();
      const saved = parseCheckpointDetails(details);
      assert.ok(saved);
      marker = checkpointMarker(saved.checkpointId);
      await fixture.session.prompt(`Continue. ${"Use the compacted history. ".repeat(40)}`);
      const prior = fixture.requests.at(-1)?.payload;
      assert.ok(prior && Array.isArray(prior.input));
      assert.equal(countType(prior.input, "compaction"), 1);
      assert.ok(JSON.stringify(prior.input).includes(wireOnly));
      assert.deepEqual(fixture.errors, []);

      failRecording = true;
      await fixture.session.prompt("Continue with the request-local note.");
      const replayErrors = [...fixture.errors];
      const failed = fixture.requests.at(-1)?.payload;
      assert.ok(failed && Array.isArray(failed.input));
      assert.deepEqual(failed.reasoning, { effort: "low" });

      await fixture.session.compact();
      const compact = fixture.requests.at(-1)?.payload;
      assert.ok(compact && Array.isArray(compact.input));
      assert.equal(countType(compact.input, "compaction_trigger"), 1);
      assert.equal(countType(compact.input, "compaction"), 1);
      const text = JSON.stringify(compact.input);
      assert.ok(text.includes(annotation));
      assert.ok(!text.includes(wireOnly), "Do not reuse the previous observed wire input");
      assert.ok(!text.includes("PI_CODEX_REMOTE_CHECKPOINT"));
      assert.equal(replayErrors.length, 1);
      assert.match(replayErrors[0], /contained 2 checkpoint markers/);
    } finally {
      await fixture.close();
    }
  });

  test(`${api} V2 uses this turn's context after a checkpoint replay error`, { timeout: 20_000 }, async () => {
    const wireOnly = "Only present in the previous request payload.";
    let marker: string | undefined;
    let duplicateMarker = false;
    const editRequest: ExtensionFactory = (pi) => {
      pi.on("context", (event) => duplicateMarker ? { messages: transforms.annotate(event.messages) } : undefined);
      pi.on("before_provider_request", ({ payload }) => {
        const activeMarker = marker;
        if (activeMarker === undefined) return;
        assert.ok(isObject(payload) && Array.isArray(payload.input));
        if (!duplicateMarker) {
          const item = { type: "message", role: "user", content: [{ type: "input_text", text: wireOnly }] };
          return { ...payload, input: [...payload.input, item] };
        }
        const checkpoint = payload.input.find((item) => hasCheckpointMarker({ input: [item] }, activeMarker));
        assert.ok(checkpoint);
        return { ...payload, input: [...payload.input, checkpoint],
          prompt_cache_key: "fixture-replay-error-cache", prompt_cache_options: { ttl: "30m" } };
      });
    };
    const fixture = await sessionFixture({ api, extensions: [editRequest, codexCompaction] });
    try {
      for (let turn = 0; turn < 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Keep the decisions. ".repeat(80)}`);
      const { details } = await fixture.session.compact();
      const saved = parseCheckpointDetails(details);
      assert.ok(saved);
      marker = checkpointMarker(saved.checkpointId);

      await fixture.session.prompt(`Continue with the checkpoint. ${"Use the compacted history. ".repeat(40)}`);
      const prior = fixture.requests.at(-1)?.payload;
      assert.ok(prior && Array.isArray(prior.input));
      assert.equal(countType(prior.input, "compaction"), 1);
      assert.ok(JSON.stringify(prior.input).includes(wireOnly));
      assert.deepEqual(fixture.errors, []);

      duplicateMarker = true;
      await fixture.session.prompt("Continue with the request-local note.");
      assert.equal(fixture.errors.length, 1);
      assert.match(fixture.errors[0], /contained 2 checkpoint markers/);
      const failed = fixture.requests.at(-1)?.payload;
      assert.ok(failed);

      await fixture.session.compact();
      const compact = fixture.requests.at(-1)?.payload;
      assert.ok(compact && Array.isArray(compact.input));
      assert.equal(countType(compact.input, "compaction_trigger"), 1);
      assert.equal(countType(compact.input, "compaction"), 1);
      const text = JSON.stringify(compact.input);
      assert.deepEqual({
        note: text.includes(annotation), previousWireText: text.includes(wireOnly),
        cacheKey: compact.prompt_cache_key, cachePolicy: compact.prompt_cache_options,
      }, {
        note: true, previousWireText: false,
        cacheKey: failed.prompt_cache_key, cachePolicy: failed.prompt_cache_options,
      });
    } finally {
      await fixture.close();
    }
  });

  test(`${api} skips checkpoint replay when a context hook restores a canonically edited message`,
    { timeout: 30_000 }, async () => {
      const originalText = `Original retained message. ${"Keep the decisions. ".repeat(80)}`;
      const editedText = "Saved edit to the retained message.";
      const continuation = "Continue after the saved edit.";
      let editedEntryId: string | undefined;
      const restoreOriginal: ExtensionFactory = (pi) => void pi.on("context", (event, ctx) => {
        if (editedEntryId === undefined) return;
        const entry = ctx.sessionManager.getEntry(editedEntryId);
        assert.ok(entry?.type === "message" && entry.message.role === "user");
        const original = entry.message;
        const edited = event.messages.find((message) => message.role === "user" && message.timestamp === original.timestamp);
        assert.deepEqual(edited, { ...original, content: editedText }, "Pi supplies the saved edit to the context hook");
        return { messages: event.messages.map((message) => message === edited ? original : message) };
      });
      const fixture = await sessionFixture({ api, extensions: [codexCompaction, restoreOriginal] });
      try {
        await fixture.session.prompt("Start the task.");
        await fixture.session.prompt("Work on the first decision.");
        await fixture.session.prompt(originalText);
        const { firstKeptEntryId, details } = await fixture.session.compact();
        assert.ok(parseCheckpointDetails(details), "Pi creates a valid V2 checkpoint");
        const { sessionManager } = fixture.session;
        const kept = sessionManager.getEntry(firstKeptEntryId);
        assert.ok(kept?.type === "message" && kept.message.role === "user");
        assert.deepEqual(kept.message.content, [{ type: "text", text: originalText }]);
        sessionManager.appendContextEdit(firstKeptEntryId, { content: editedText });
        editedEntryId = firstKeptEntryId;

        await fixture.session.prompt(continuation);
        assert.deepEqual(fixture.errors, []);
        const payload = fixture.requests.at(-1)?.payload;
        assert.ok(payload && Array.isArray(payload.input));
        const input = JSON.stringify(payload.input);
        assert.ok(!input.includes("PI_CODEX_REMOTE_CHECKPOINT"), "The private checkpoint marker stays off the wire");
        assert.ok(input.includes(continuation), "The new user turn remains in the ordinary input");
        assert.deepEqual(payload.input.filter((item) => isObject(item) && item.type === "compaction"), [],
          "A request-local restoration must not replay opaque history after a saved context edit");
        assert.ok(input.includes(originalText), "The request-local restoration remains in the ordinary input");
      } finally {
        await fixture.close();
      }
    });
}
