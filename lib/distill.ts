import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { estimateTokens } from "./tokens";
import {
  type CachedPage,
  getCachedPage,
  putCachedPage,
  recordSave,
  urlHash,
} from "./cache";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// Drop pure-noise nodes entirely.
turndown.remove(["script", "style", "noscript", "iframe", "form"]);
turndown.remove((node) => node.nodeName.toUpperCase() === "SVG");

const UA =
  "Slipstream/0.1 (+https://github.com/) AI-agent shared cache; like Mozilla/5.0";

export type DistillResult = {
  url: string;
  markdown: string;
  originalTokens: number;
  distilledTokens: number;
  tokensSaved: number;
  cacheHit: boolean;
  fromUrlHash: string;
};

/** Strip a raw HTML document down to its readable core, as markdown. */
function htmlToDistilledMarkdown(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Try Readability first (best signal-to-noise); fall back to <body>.
  let contentHtml: string | null = null;
  try {
    const article = new Readability(doc).parse();
    if (article?.content) contentHtml = article.content;
  } catch {
    /* fall through to body */
  }
  if (!contentHtml) contentHtml = doc.body?.innerHTML ?? html;

  const md = turndown.turndown(contentHtml);
  // Collapse the whitespace explosion turndown sometimes produces.
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

/** Optionally clip distilled markdown to a token budget, on paragraph bounds. */
function clipToBudget(markdown: string, tokenBudget?: number): string {
  if (!tokenBudget || estimateTokens(markdown) <= tokenBudget) return markdown;
  const charBudget = tokenBudget * 4;
  let out = markdown.slice(0, charBudget);
  const lastBreak = out.lastIndexOf("\n\n");
  if (lastBreak > charBudget * 0.5) out = out.slice(0, lastBreak);
  return `${out.trim()}\n\n_[Slipstream: clipped to ~${tokenBudget} tokens]_`;
}

/**
 * Fetch (or serve from the shared cache) a URL, distilled to token-optimal
 * markdown. The distillation is content-addressed and shared across all agents:
 * the first agent pays the crawl, every agent after drafts in its slipstream.
 */
export async function distill(
  url: string,
  tokenBudget?: number,
): Promise<DistillResult> {
  const hash = urlHash(url);

  const cached = await getCachedPage(hash);
  if (cached) {
    const markdown = clipToBudget(cached.markdown, tokenBudget);
    const distilledTokens = estimateTokens(markdown);
    const tokensSaved = Math.max(0, cached.originalTokens - distilledTokens);
    await recordSave(tokensSaved, true);
    return {
      url: cached.url,
      markdown,
      originalTokens: cached.originalTokens,
      distilledTokens,
      tokensSaved,
      cacheHit: true,
      fromUrlHash: hash,
    };
  }

  // Cache miss: crawl, distill, store for everyone who comes next.
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
  }
  const rawHtml = await res.text();
  const originalTokens = estimateTokens(rawHtml);
  const fullMarkdown = htmlToDistilledMarkdown(rawHtml, url);

  const page: CachedPage = {
    url,
    markdown: fullMarkdown,
    originalTokens,
    distilledTokens: estimateTokens(fullMarkdown),
    createdAt: Date.now(),
  };
  await putCachedPage(hash, page);

  const markdown = clipToBudget(fullMarkdown, tokenBudget);
  const distilledTokens = estimateTokens(markdown);
  const tokensSaved = Math.max(0, originalTokens - distilledTokens);
  await recordSave(tokensSaved, false);

  return {
    url,
    markdown,
    originalTokens,
    distilledTokens,
    tokensSaved,
    cacheHit: false,
    fromUrlHash: hash,
  };
}
