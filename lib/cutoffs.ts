// Approximate training cutoffs for common models, so an agent can pass its
// model id instead of a date. These are deliberately rough — always overridable
// with an explicit `since` date, and labeled "approx" wherever surfaced.
export const KNOWN_CUTOFFS: Record<string, string> = {
  "claude-opus-4-8": "2026-01-01",
  "claude-opus-4": "2025-10-01",
  "claude-sonnet-4": "2025-08-01",
  "claude-haiku-4": "2025-08-01",
  "claude-3-5-sonnet": "2024-04-01",
  "claude-3": "2023-08-01",
  "gpt-4o": "2024-06-01",
  "gpt-4.1": "2024-06-01",
  "gpt-4-turbo": "2023-12-01",
  "gpt-4": "2023-09-01",
  "o1": "2024-10-01",
  "o3": "2025-01-01",
  "gemini-2": "2025-01-01",
  "gemini-1.5": "2024-04-01",
  "llama-3": "2023-12-01",
};

/** Resolve a model id (substring match) to an approximate cutoff ISO date. */
export function resolveCutoff(model?: string): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  // Longest key first so "claude-opus-4-8" wins over "claude-opus-4".
  for (const key of Object.keys(KNOWN_CUTOFFS).sort((a, b) => b.length - a.length)) {
    if (m.includes(key)) return KNOWN_CUTOFFS[key];
  }
  return null;
}
