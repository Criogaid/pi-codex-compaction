// Own Codex's approximate token counting and UTF-8 middle truncation.
const APPROX_BYTES_PER_TOKEN = 4;

export function approximateTokensFromBytes(bytes: number): number {
  return bytes <= 0 ? 0 : Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);
}
export function approximateBytesForTokens(tokens: number): number {
  return tokens * APPROX_BYTES_PER_TOKEN;
}
export function approximateTokenCount(text: string): number {
  return approximateTokensFromBytes(Buffer.byteLength(text, "utf8"));
}
export function truncateTextToTokenBudget(text: string, maxTokens: number): string {
  const budgetBytes = maxTokens * APPROX_BYTES_PER_TOKEN;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= budgetBytes) return text;
  const prefixBudgetBytes = Math.floor(budgetBytes / 2);
  const suffixStartBytes = totalBytes - (budgetBytes - prefixBudgetBytes);
  // Track UTF-16 indices of the character boundaries so both ends are sliced once.
  let offsetBytes = 0;
  let index = 0;
  let prefixEnd = 0;
  let suffixStart = text.length;
  for (const character of text) {
    const endBytes = offsetBytes + Buffer.byteLength(character, "utf8");
    if (endBytes <= prefixBudgetBytes) prefixEnd = index + character.length;
    else if (offsetBytes >= suffixStartBytes) {
      suffixStart = index;
      break;
    }
    offsetBytes = endBytes;
    index += character.length;
  }
  const marker = `…${approximateTokensFromBytes(totalBytes - budgetBytes)} tokens truncated…`;
  return `${text.slice(0, prefixEnd)}${marker}${text.slice(suffixStart)}`;
}
