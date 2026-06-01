import { estimateTokens } from "./tokens";

// JS rendering for SPAs. We deliberately do NOT bundle a headless Chromium
// (huge cold starts + Vercel size limits, fragile). Instead we delegate to
// Firecrawl when configured — it renders the page and returns clean markdown.
// Without a key, Slipstream falls back to static distillation and labels the
// result as possibly partial (honest, not silently wrong).

const FIRECRAWL_TIMEOUT_MS = 25_000;

export function rendererAvailable(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

export type Rendered = { markdown: string; rawTokens: number };

export async function renderJs(url: string): Promise<Rendered | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FIRECRAWL_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["markdown", "rawHtml"], onlyMainContent: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: { markdown?: string; rawHtml?: string };
    };
    const md = j?.data?.markdown;
    if (typeof md !== "string" || !md.trim()) return null;
    const rawHtml = j?.data?.rawHtml ?? "";
    return {
      markdown: md.replace(/\n{3,}/g, "\n\n").trim(),
      rawTokens: estimateTokens(rawHtml || md),
    };
  } catch {
    return null; // timeout / network / Firecrawl error → graceful fallback
  } finally {
    clearTimeout(timer);
  }
}

// An under-rendered SPA: lots of HTML but almost no extractable text, plus a
// client-app mount marker. These are exactly the pages static fetch lies about.
export function isLikelySpa(
  html: string,
  originalTokens: number,
  distilledTokens: number,
): boolean {
  if (originalTokens < 1000) return false;
  const ratio = distilledTokens / originalTokens;
  const shell =
    /<div[^>]+id=["'](root|app|__next)["']|data-reactroot|__NEXT_DATA__|window\.__NUXT__|ng-version|<div[^>]+id=["']svelte/i.test(
      html,
    );
  // Lots of HTML but almost no extractable text => extraction failed (the
  // classic SPA lie), regardless of which framework's shell it is.
  const veryThin = ratio < 0.02 && originalTokens > 3000;
  // A clear app shell needs less evidence of thinness.
  const thinWithShell = (distilledTokens < 200 || ratio < 0.05) && shell;
  return veryThin || thinWithShell;
}
