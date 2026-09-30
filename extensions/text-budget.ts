// Own Codex's approximate token counting and UTF-8 middle truncation.
const APPROX_BYTES_PER_TOKEN = 4;

export function approximateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);
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
  let offsetBytes = 0;
  let prefix = "";
  let suffix = "";
  for (const character of text) {
    const endBytes = offsetBytes + Buffer.byteLength(character, "utf8");
    if (endBytes <= prefixBudgetBytes) prefix += character;
    else if (offsetBytes >= suffixStartBytes) suffix += character;
    offsetBytes = endBytes;
  }
  return `${prefix}…${approximateTokensFromBytes(totalBytes - budgetBytes)} tokens truncated…${suffix}`;
}
