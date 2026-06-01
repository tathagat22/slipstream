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
turndown.remove(["script", "style", "noscript", "iframe", "form"]);
turndown.remove((node) => node.nodeName.toUpperCase() === "SVG");

// Keep <pre>/<code> verbatim — code is the highest-value, most token-fragile
// content an agent fetches, and Readability can mangle it.
turndown.addRule("fencedPre", {
  filter: (node) => node.nodeName === "PRE",
  replacement: (_content, node) => {
    const text = (node as HTMLElement).textContent ?? "";
    return `\n\n\`\`\`\n${text.replace(/\n+$/, "")}\n\`\`\`\n\n`;
  },
});

const UA =
  "Slipstream/0.2 (+https://github.com/tathagat22/slipstream) AI-agent shared cache";

// Entries older than this are revalidated (conditional GET) on the next hit.
const TTL_MS = 24 * 60 * 60 * 1000;

// Chrome/boilerplate that Readability sometimes keeps but agents never want.
const NOISE_SELECTORS =
  "nav, header, footer, aside, [role=navigation], [role=banner], " +
  "[role=contentinfo], .sidebar, .nav, .navbar, .menu, .breadcrumb, " +
  ".cookie, .cookies, .advertisement, .ad, .ads, .promo, .newsletter, " +
  ".social, .share, .related, .comments, [aria-hidden=true]";

export type DistillResult = {
  url: string;
  markdown: string;
  originalTokens: number;
  distilledTokens: number;
  tokensSaved: number;
  cacheHit: boolean;
  revalidated: boolean;
  fromUrlHash: string;
};

function htmlToDistilledMarkdown(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Strip obvious chrome before Readability so the signal is cleaner.
  doc.querySelectorAll(NOISE_SELECTORS).forEach((el) => el.remove());

  let contentHtml: string | null = null;
  try {
    const article = new Readability(doc).parse();
    if (article?.content) contentHtml = article.content;
  } catch {
    /* fall through to body */
  }
  if (!contentHtml) contentHtml = doc.body?.innerHTML ?? html;

  const md = turndown.turndown(contentHtml);
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

function clipToBudget(markdown: string, tokenBudget?: number): string {
  if (!tokenBudget || estimateTokens(markdown) <= tokenBudget) return markdown;
  const charBudget = tokenBudget * 4;
  let out = markdown.slice(0, charBudget);
  const lastBreak = out.lastIndexOf("\n\n");
  if (lastBreak > charBudget * 0.5) out = out.slice(0, lastBreak);
  return `${out.trim()}\n\n_[Slipstream: clipped to ~${tokenBudget} tokens]_`;
}

async function crawl(
  url: string,
  prev?: CachedPage,
): Promise<{ status: number; html?: string; etag?: string; lastModified?: string }> {
  const headers: Record<string, string> = {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml",
  };
  // Conditional GET — let the origin tell us "nothing changed" (304) for free.
  if (prev?.etag) headers["if-none-match"] = prev.etag;
  if (prev?.lastModified) headers["if-modified-since"] = prev.lastModified;

  const res = await fetch(url, { headers, redirect: "follow" });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) {
    throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
  }
  return {
    status: res.status,
    html: await res.text(),
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
}

function result(
  page: CachedPage,
  tokenBudget: number | undefined,
  cacheHit: boolean,
  revalidated: boolean,
  hash: string,
): DistillResult {
  const markdown = clipToBudget(page.markdown, tokenBudget);
  const distilledTokens = estimateTokens(markdown);
  return {
    url: page.url,
    markdown,
    originalTokens: page.originalTokens,
    distilledTokens,
    tokensSaved: Math.max(0, page.originalTokens - distilledTokens),
    cacheHit,
    revalidated,
    fromUrlHash: hash,
  };
}

/**
 * Fetch (or serve from the shared cache) a URL, distilled to token-optimal
 * markdown. Content-addressed and shared across all agents: the first agent pays
 * the crawl; every agent after drafts in its slipstream. Stale entries are
 * revalidated with a conditional GET so a 304 still serves the cache for free.
 */
export async function distill(
  url: string,
  tokenBudget?: number,
): Promise<DistillResult> {
  const hash = urlHash(url);
  const cached = await getCachedPage(hash);

  const fresh = cached && Date.now() - cached.createdAt < TTL_MS;
  if (cached && fresh) {
    const r = result(cached, tokenBudget, true, false, hash);
    await recordSave(r.tokensSaved, true, url);
    return r;
  }

  // Stale hit → conditional revalidate. Cold miss → full crawl.
  const fetched = await crawl(url, cached ?? undefined);

  if (fetched.status === 304 && cached) {
    const refreshed: CachedPage = { ...cached, createdAt: Date.now() };
    await putCachedPage(hash, refreshed, false);
    const r = result(refreshed, tokenBudget, true, true, hash);
    await recordSave(r.tokensSaved, true, url);
    return r;
  }

  const html = fetched.html ?? "";
  const originalTokens = estimateTokens(html);
  const fullMarkdown = htmlToDistilledMarkdown(html, url);
  const page: CachedPage = {
    url,
    markdown: fullMarkdown,
    originalTokens,
    distilledTokens: estimateTokens(fullMarkdown),
    createdAt: Date.now(),
    etag: fetched.etag,
    lastModified: fetched.lastModified,
  };
  await putCachedPage(hash, page, !cached);

  const r = result(page, tokenBudget, false, false, hash);
  await recordSave(r.tokensSaved, false, url);
  return r;
}
