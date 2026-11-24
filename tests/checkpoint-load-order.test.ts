// Require checkpoint replay and request reuse to be independent of extension load order.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createCodexCompactionExtension } from "../src/index.js";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { isObject, type JsonObject } from "../src/protocol.js";
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
  const compactor = createCodexCompactionExtension();
  const fixture = await sessionFixture({ api, extensions: order === "before" ? [hook, compactor] : [compactor, hook] });
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
      const fixture = await sessionFixture({ api, extensions: [createCodexCompactionExtension(), restoreOriginal] });
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
