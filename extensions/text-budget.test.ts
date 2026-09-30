import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approximateBytesForTokens,
  approximateTokenCount,
  approximateTokensFromBytes,
  truncateTextToTokenBudget,
} from "./text-budget.js";

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

// Golden outputs from the pre-runtime-parameters truncator, including partial grapheme clusters.
for (const [text, budget, expected] of [
  ["", 0, ""],
  ["a", 0, "…1 tokens truncated…"],
  ["😀", 0, "…1 tokens truncated…"],
  ["abcd", 1, "abcd"],
  ["abcde", 1, "ab…1 tokens truncated…de"],
  ["abcdefghij", 1, "ab…2 tokens truncated…ij"],
  ["abcdefghij", 2, "abcd…1 tokens truncated…ghij"],
  ["😀😀😀", 1, "…2 tokens truncated…"],
  ["😀😀😀", 2, "😀…1 tokens truncated…😀"],
  ["é中😀z", 1, "é…2 tokens truncated…z"],
  ["中😀文", 2, "中…1 tokens truncated…文"],
  ["e\u0301e\u0301", 1, "e…1 tokens truncated…\u0301"],
  ["café", 1, "ca…1 tokens truncated…é"],
  ["\ud800abcd\udc00", 2, "\ud800a…1 tokens truncated…d\udc00"],
  ["é中😀", 3, "é中😀"],
] as const) {
  test(`preserves legacy truncation for ${JSON.stringify(text)} at ${budget} tokens`, () => {
    assert.equal(truncateTextToTokenBudget(text, budget), expected);
  });
}
