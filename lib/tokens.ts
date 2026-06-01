// Cheap, dependency-free token estimate. ~4 chars/token is the well-known
// rule of thumb for English + code and is plenty accurate for "tokens saved"
// accounting where we only care about relative magnitude, not exact billing.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
