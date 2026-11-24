import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { applyCodexEffortUpdates as rewrite } from "../src/effort-updates.js";

const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const message = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });

function nativeSummaryText(summary: string): string {
  const [converted] = convertToLlm([{ role: "compactionSummary", summary, tokensBefore: 100, timestamp: 0 }]);
  assert.ok(converted?.role === "user" && Array.isArray(converted.content) && converted.content.length === 1);
  const [part] = converted.content;
  assert.equal(part.type, "text");
  return part.text;
}

const summaryBody = "Summary of previous turns";
const summaryText = nativeSummaryText(summaryBody);
const summary = message(summaryText);

test("dense histories retain the first effort and each change, including changes back", () => {
  const a = message("a"), b = message("b"), c = message("c");
  const payload = { input: [a, update("low"), b, update("low"), update("high"), update("high"), c, update("low")], reasoning: { effort: "medium", summary: "auto" }, extra: true };
  const original = structuredClone(payload);
  const expected = { ...payload, input: [a, update("low"), b, update("high"), c, update("low")], reasoning: { effort: "low", summary: "auto" } };
  assert.deepEqual(rewrite(payload), expected);
  assert.deepEqual(payload, original);
});

for (const [name, boundary] of [
  ["compaction", { type: "compaction" }],
  ["compaction_summary", { type: "compaction_summary" }],
  ["context_compaction", { type: "context_compaction" }],
  ["native summary", summary],
  ["empty native summary", message(nativeSummaryText(""))],
] as const) {
  test(`compacted window resets baseline: ${name}`, () => {
    const input = [update("high"), message("old"), boundary, update("low"), message("new"), update("low"), update("high")];
    assert.deepEqual(rewrite({ input, reasoning: { effort: "medium" } }), {
      input: [update("high"), message("old"), boundary, message("new"), update("high")], reasoning: { effort: "low" },
    });
  });
}

test("only a user message with a single input_text part recognizes a native summary", () => {
  for (const item of [{ ...summary, role: "assistant" }, { ...summary, content: [message("ordinary").content[0], ...summary.content] }, { ...summary, content: [{ type: "text", text: summary.content[0].text }] }]) {
    const payload = { input: [item, update("low")], reasoning: { effort: "low" } };
    assert.equal(rewrite(payload), payload);
  }
});

for (const [name, item] of [
  ["ordinary text beginning with the native summary sentence", message(`${summaryText.split("\n", 1)[0]} what does this mean?`)],
  ["native summary text without the closing suffix", message(summaryText.slice(0, summaryText.indexOf(summaryBody) + summaryBody.length))],
  ["native summary text followed by an image part", {
    ...summary,
    content: [...summary.content, { type: "input_image", detail: "auto", image_url: "https://example.com/image.png" }],
  }],
] as const) {
  test(`preserves the effort window for ${name}`, () => {
    const low = update("low");
    const high = update("high");
    const greeting = message("hi");
    assert.deepEqual(rewrite({ input: [low, greeting, low, item, high], reasoning: { effort: "medium" } }), {
      input: [low, greeting, item, high],
      reasoning: { effort: "low" },
    });
  });
}

test("removes all adjacent updates before every compaction trigger", () => {
  const trigger = { type: "compaction_trigger" };
  assert.deepEqual(rewrite({ input: [message("a"), update("low"), update("high"), trigger, message("b"), update("low"), trigger], reasoning: { effort: "medium" } }), {
    input: [message("a"), trigger, message("b"), trigger], reasoning: { effort: "low" },
  });
});

test("invalid payloads, malformed updates, and unchanged payloads preserve identity", () => {
  for (const payload of [null, undefined, 1, "text", [], {}, { input: null }, { input: {} }, { input: [] }, { input: [message("a")] }, { input: [update("low")], reasoning: { effort: "low" } }, { input: [update("low")] }]) assert.equal(rewrite(payload), payload);
  const malformed = [null, { type: "configuration_update" }, { type: "configuration_update", reasoning: null }, { type: "configuration_update", reasoning: { effort: 1 } }];
  const payload = { input: malformed, reasoning: { effort: "medium" } };
  assert.equal(rewrite(payload), payload);
  assert.deepEqual(rewrite({ input: [...malformed, update("low"), ...malformed, update("low")], reasoning: { effort: "medium" } }), { input: [...malformed, update("low"), ...malformed], reasoning: { effort: "low" } });
});

test("non-object reasoning passes through and an empty compacted window has no baseline", () => {
  for (const reasoning of [undefined, null, [], "medium"]) {
    assert.deepEqual(rewrite({ input: [update("low"), update("low")], reasoning }), { input: [update("low")], reasoning });
  }
  const payload = { input: [update("high"), { type: "compaction" }], reasoning: { effort: "medium" } };
  assert.equal(rewrite(payload), payload);
});

test("rewritten request prefixes remain stable as new turns arrive", () => {
  for (const efforts of [["low", "low", "high", "high", "low"], ["high", "low", "high"]]) {
    let history: unknown[] = [message("start")];
    for (const effort of efforts) {
      const current = { input: [...history, update(effort)], reasoning: { effort: "medium" } };
      const result = rewrite(current);
      assert.ok(typeof result === "object" && result !== null && "input" in result && Array.isArray(result.input));
      history = [...current.input, message("next")];
      const next = rewrite({ input: [...history, update(effort)], reasoning: { effort: "medium" } });
      assert.ok(typeof next === "object" && next !== null && "input" in next && Array.isArray(next.input));
      assert.deepEqual(next.input.slice(0, result.input.length), result.input);
      const withoutTail = rewrite({ input: [...current.input.slice(0, -1), message("next"), update("high")], reasoning: { effort: "medium" } });
      assert.ok(typeof withoutTail === "object" && withoutTail !== null && "input" in withoutTail && Array.isArray(withoutTail.input));
      const prefix = result.input.at(-1) === current.input.at(-1) ? result.input.slice(0, -1) : result.input;
      assert.deepEqual(withoutTail.input.slice(0, prefix.length), prefix);
    }
  }
});

test("rewriting is idempotent on the returned payload and a copy is rewritten again", () => {
  const compaction = { type: "compaction" };
  const next = message("Next turn");
  const once = rewrite({
    input: [compaction, update("low"), next, update("high")],
    reasoning: { effort: "medium" },
  });
  const expected = { input: [compaction, next, update("high")], reasoning: { effort: "low" } };
  assert.deepEqual(once, expected);
  assert.equal(rewrite(once), once);
  assert.equal(JSON.stringify(once), JSON.stringify(expected));
  assert.ok(typeof once === "object" && once !== null);
  for (const copy of [structuredClone(once), { ...once }]) {
    const twice = rewrite(copy);
    assert.notEqual(twice, copy);
    assert.deepEqual(twice, { input: [compaction, next], reasoning: { effort: "high" } });
    assert.equal(rewrite(twice), twice);
  }
});

test("a payload marked by the standalone extension is passed through", () => {
  const payload = { input: [update("low"), update("low")], reasoning: { effort: "medium" } };
  // The shared marker is the compatibility contract between the two extensions.
  Object.defineProperty(payload, Symbol.for("@criogaid/pi-codex-reasoning-effort/rewritten"), { value: true });
  assert.equal(rewrite(payload), payload);
});
