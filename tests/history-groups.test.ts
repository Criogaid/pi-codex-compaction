import assert from "node:assert/strict";
import { test } from "node:test";
import { historyGroups, inputText, matchesMarkedText, trimWhiteSpace, type HistoryGroup } from "../src/history-groups.js";
import type { JsonObject } from "../src/protocol.js";

const markers = ["<image_resize_notice>", "</image_resize_notice>"] as const;
const notice = { role: "developer", content: [{ type: "input_text", text: "\u0085<IMAGE_RESIZE_NOTICE>resized</image_RESIZE_notice>\u3000" }] };
const source = { type: "function_call_output", output: "image result" };

for (const type of [undefined, "message"]) {
  test(`attaches an immediately following developer resize notice with type ${type}`, () => {
    const following = { ...notice, type };
    const input = [source, following];
    const saved = structuredClone(input);
    const groups: HistoryGroup[] = historyGroups(input);
    assert.deepEqual(groups, [{ source, notice: following }]);
    assert.equal(groups[0].source, source);
    assert.equal(groups[0].notice, following);
    assert.deepEqual(input, saved);
  });
}

test("resize notice recognition requires one input_text part, developer role, and a message item", () => {
  const lookalikes: JsonObject[] = [
    { ...notice, role: "DEVELOPER" }, { ...notice, role: "system" },
    { ...notice, type: null }, { ...notice, type: "compaction" },
    { ...notice, content: [] }, { ...notice, content: notice.content[0] },
    { ...notice, content: [...notice.content, { type: "input_image", image_url: "fixture" }] },
    { ...notice, content: [{ type: "text", text: notice.content[0].text }] },
    { ...notice, content: [{ type: "input_text", text: 1 }] },
    { ...notice, content: [{ type: "input_text", text: "<image_resize_notice>missing closing marker" }] },
    { ...notice, content: [{ type: "input_text", text: "<image_resize_notice>body</image_resize_notice>suffix" }] },
    { ...notice, content: [{ type: "input_text", text: "\uFEFF<image_resize_notice>body</image_resize_notice>" }] },
  ];
  for (const lookalike of lookalikes) {
    assert.deepEqual(historyGroups([source, lookalike]), [
      { source, notice: undefined }, { source: lookalike, notice: undefined },
    ], JSON.stringify(lookalike));
  }
});

test("a separated resize notice attaches to the immediately preceding item only", () => {
  const intervening = { role: "user", content: [{ type: "input_text", text: "intervening request" }] };
  assert.deepEqual(historyGroups([source, intervening, notice]), [
    { source, notice: undefined }, { source: intervening, notice },
  ]);
});

test("marked text matches both boundaries with ASCII case folding", () => {
  assert.equal(matchesMarkedText("<IMAGE_RESIZE_NOTICE>Body</image_RESIZE_notice>", markers), true);
  assert.equal(matchesMarkedText("<image_resize_notice></IMAGE_RESIZE_NOTICE>", ["<IMAGE_RESIZE_NOTICE>", "</image_resize_notice>"]), true);
  for (const text of ["prefix<image_resize_notice>x</image_resize_notice>",
    "<image_resize_notice>x</image_resize_notice>suffix", " <image_resize_notice>x</image_resize_notice>",
    "<image_resize_notice>x</image_resize_notice> ", "<image_resize_notice>x", ""]) {
    assert.equal(matchesMarkedText(text, markers), false, text);
  }
  assert.equal(matchesMarkedText("<K>x</K>", ["<k>", "</k>"]), false, "Unicode lowercase equivalents are not ASCII matches");
  assert.equal(matchesMarkedText("<K>x</k>", ["<K>", "</K>"]), false, "markers use the same ASCII-only rule");
});

test("trims Unicode White_Space at the edges while preserving internal whitespace and BOM", () => {
  // Unicode White_Space includes NEL; ECMAScript trim instead includes the BOM.
  const whiteSpace = "\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000";
  for (const edge of whiteSpace) assert.equal(trimWhiteSpace(`${edge}body${edge}`), "body");
  assert.equal(trimWhiteSpace(whiteSpace), "");
  assert.equal(trimWhiteSpace(`${whiteSpace}inside\u0085 \ntext${whiteSpace}`), "inside\u0085 \ntext");
  assert.equal(trimWhiteSpace(`${whiteSpace}\uFEFFbody\uFEFF${whiteSpace}`), "\uFEFFbody\uFEFF");
  assert.equal(trimWhiteSpace("\uFEFF body \uFEFF"), "\uFEFF body \uFEFF");
  assert.equal(trimWhiteSpace("\u200Bbody\u200B"), "\u200Bbody\u200B");
  assert.equal(trimWhiteSpace(""), "");
});

test("inputText trims input_text strings and rejects other part shapes", () => {
  assert.equal(inputText({ type: "input_text", text: "\u0085 body \u3000" }), "body");
  assert.equal(inputText({ type: "input_text", text: " \uFEFFbody " }), "\uFEFFbody");
  assert.equal(inputText({ type: "input_text", text: " " }), "");
  for (const part of [undefined, null, "body", [], {}, { type: "text", text: "body" },
    { type: "input_text" }, { type: "input_text", text: null }, { type: "input_text", text: 1 }]) {
    assert.equal(inputText(part), undefined);
  }
});
