import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approximateBytesForTokens,
  approximateTokenCount,
  approximateTokensFromBytes,
  truncateTextToTokenBudget,
} from "../src/text-budget.js";

test("converts token budgets to bytes without rounding or clamping", () => {
  for (const [tokens, bytes] of [[0, 0], [1, 4], [1.5, 6], [64_000, 256_000], [-1, -4]]) {
    assert.equal(approximateBytesForTokens(tokens), bytes);
  }
});

test("clamps nonpositive bytes and rounds positive byte counts upward", () => {
  for (const [bytes, tokens] of [[-Infinity, 0], [-5, 0], [-0, 0], [0, 0], [0.5, 1], [1, 1], [4, 1], [5, 2], [7_373, 1_844]]) {
    assert.equal(approximateTokensFromBytes(bytes), tokens, String(bytes));
  }
});

test("counts UTF-8 bytes instead of UTF-16 code units", () => {
  for (const [text, tokens] of [["", 0], ["abcd", 1], ["abcde", 2], ["é中😀", 3], ["\ud800", 1]] as const) {
    assert.equal(approximateTokenCount(text), tokens, JSON.stringify(text));
  }
});

for (const [text, budget, prefix, suffix, omittedTokens] of [
  ["", 0, "", "", 0],
  ["a", 0, "", "", 1],
  ["😀", 0, "", "", 1],
  ["abcd", 1, "abcd", "", 0],
  ["abcde", 1, "ab", "de", 1],
  ["abcdefghij", 1, "ab", "ij", 2],
  ["abcdefghij", 2, "abcd", "ghij", 1],
  ["😀😀😀", 1, "", "", 2],
  ["😀😀😀", 2, "😀", "😀", 1],
  ["é中😀z", 1, "é", "z", 2],
  ["中😀文", 2, "中", "文", 1],
  ["e\u0301e\u0301", 1, "e", "\u0301", 1],
  ["café", 1, "ca", "é", 1],
  ["\ud800abcd\udc00", 2, "\ud800a", "d\udc00", 1],
  ["é中😀", 3, "é中😀", "", 0],
] as const) {
  test(`retains the budgeted boundaries of ${JSON.stringify(text)} at ${budget} tokens`, () => {
    const actual = truncateTextToTokenBudget(text, budget);
    if (omittedTokens === 0) {
      assert.equal(actual, text);
    } else {
      assert.ok(actual.startsWith(prefix));
      assert.ok(actual.endsWith(suffix));
      const notice = actual.slice(prefix.length, actual.length - suffix.length);
      assert.deepEqual(notice.match(/\d+/g), [String(omittedTokens)]);
      assert.ok(!notice.includes("\uFFFD"));
    }
  });
}
