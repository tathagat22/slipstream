import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { estimateTokens } from "./tokens";
import {
  type CachedPage,
  getCachedPage,
  getNotes,
  type Note,
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
  "Slipstream/0.3 (+https://github.com/tathagat22/slipstream) AI-agent shared cache";

const TTL_MS = 24 * 60 * 60 * 1000;

const NOISE_SELECTORS =
  "nav, header, footer, aside, [role=navigation], [role=banner], " +
  "[role=contentinfo], .sidebar, .nav, .navbar, .menu, .breadcrumb, " +
  ".cookie, .cookies, .advertisement, .ad, .ads, .promo, .newsletter, " +
  ".social, .share, .related, .comments, [aria-hidden=true]";

// Main-content containers, in priority order. Selecting one of these preserves
// the heading structure (h2/h3) that Readability tends to strip — and that
// outline/section depend on.
const MAIN_SELECTORS = [
  "main",
  "article",
  "[role=main]",
  ".mw-parser-output", // Wikipedia / MediaWiki
  ".markdown-body", // GitHub
  ".prose", // common docs (Tailwind)
  "#content",
  "#main-content",
  ".content",
  ".post",
  ".article",
];

export type DistillOptions = {
  tokenBudget?: number;
  knownHash?: string; // delta: if it matches, return ~nothing
  section?: string; // progressive disclosure: only this heading's section
};

export type DistillResult = {
  url: string;
  markdown: string;
  originalTokens: number;
  distilledTokens: number;
  tokensSaved: number;
  cacheHit: boolean;
  revalidated: boolean;
  unchanged: boolean; // delta short-circuit fired
  contentHash: string;
  notes: Note[];
  fromUrlHash: string;
};

function contentHashOf(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex").slice(0, 16);
}

function htmlToDistilledMarkdown(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  doc.querySelectorAll(NOISE_SELECTORS).forEach((el) => el.remove());

  // Prefer an explicit main-content container — it keeps heading structure.
  let contentHtml: string | null = null;
  for (const sel of MAIN_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el && (el.textContent ?? "").trim().length > 500) {
      contentHtml = el.innerHTML;
      break;
    }
  }

  // Fallback: Readability (great prose extraction, but flattens headings).
  if (!contentHtml) {
    try {
      const article = new Readability(doc).parse();
      if (article?.content) contentHtml = article.content;
    } catch {
      /* fall through to body */
    }
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

export type OutlineItem = { heading: string; level: number; tokens: number };

/** Split distilled markdown into (heading, body) sections by ATX headings. */
function splitSections(markdown: string): { heading: string; level: number; body: string }[] {
  const lines = markdown.split("\n");
  const sections: { heading: string; level: number; body: string }[] = [];
  let cur = { heading: "(intro)", level: 0, body: "" };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (cur.body.trim() || cur.heading !== "(intro)") sections.push(cur);
      cur = { heading: m[2].trim(), level: m[1].length, body: `${line}\n` };
    } else {
      cur.body += `${line}\n`;
    }
  }
  sections.push(cur);
  return sections;
}

export function outlineOf(markdown: string): OutlineItem[] {
  return splitSections(markdown)
    .filter((s) => s.heading !== "(intro)" && s.level <= 3)
    .map((s) => ({
      heading: s.heading,
      level: s.level,
      tokens: estimateTokens(s.body),
    }));
}

function extractSection(markdown: string, query: string): string | null {
  const q = query.toLowerCase().trim();
  const sections = splitSections(markdown);
  const hit =
    sections.find((s) => s.heading.toLowerCase() === q) ??
    sections.find((s) => s.heading.toLowerCase().includes(q));
  return hit ? hit.body.trim() : null;
}

async function crawl(
  url: string,
  prev?: CachedPage,
): Promise<{ status: number; html?: string; etag?: string; lastModified?: string }> {
  const headers: Record<string, string> = {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml",
  };
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

async function finalize(
  page: CachedPage,
  opts: DistillOptions,
  cacheHit: boolean,
  revalidated: boolean,
  hash: string,
): Promise<DistillResult> {
  const fullHash = page.contentHash ?? contentHashOf(page.markdown);

  // Delta short-circuit: the agent already has this exact content.
  if (opts.knownHash && opts.knownHash === fullHash) {
    const r: DistillResult = {
      url: page.url,
      markdown: `_[Slipstream: UNCHANGED since ${opts.knownHash} — nothing to re-read]_`,
      originalTokens: page.originalTokens,
      distilledTokens: estimateTokens(page.markdown),
      tokensSaved: estimateTokens(page.markdown),
      cacheHit,
      revalidated,
      unchanged: true,
      contentHash: fullHash,
      notes: [],
      fromUrlHash: hash,
    };
    await recordSave(r.tokensSaved, true, page.url);
    return r;
  }

  // Progressive disclosure: one section only, if asked and found.
  let body = page.markdown;
  if (opts.section) {
    const sec = extractSection(page.markdown, opts.section);
    if (sec) body = sec;
  }

  const markdown = clipToBudget(body, opts.tokenBudget);
  const distilledTokens = estimateTokens(markdown);
  const notes = await getNotes(page.url, 3);
  return {
    url: page.url,
    markdown,
    originalTokens: page.originalTokens,
    distilledTokens,
    tokensSaved: Math.max(0, page.originalTokens - distilledTokens),
    cacheHit,
    revalidated,
    unchanged: false,
    contentHash: fullHash,
    notes,
    fromUrlHash: hash,
  };
}

/**
 * Fetch (or serve from the shared cache) a URL, distilled to token-optimal
 * markdown — content-addressed and shared across all agents. Supports delta
 * fetch (knownHash), progressive disclosure (section), and surfaces collective
 * notes other agents left on the page.
 */
export async function distill(
  url: string,
  opts: DistillOptions = {},
): Promise<DistillResult> {
  const hash = urlHash(url);
  const cached = await getCachedPage(hash);

  const fresh = cached && Date.now() - cached.createdAt < TTL_MS;
  if (cached && fresh) {
    const page = cached.contentHash
      ? cached
      : { ...cached, contentHash: contentHashOf(cached.markdown) };
    const r = await finalize(page, opts, true, false, hash);
    if (!r.unchanged) await recordSave(r.tokensSaved, true, url);
    return r;
  }

  const fetched = await crawl(url, cached ?? undefined);

  if (fetched.status === 304 && cached) {
    const refreshed: CachedPage = {
      ...cached,
      createdAt: Date.now(),
      contentHash: cached.contentHash ?? contentHashOf(cached.markdown),
    };
    await putCachedPage(hash, refreshed, false);
    const r = await finalize(refreshed, opts, true, true, hash);
    if (!r.unchanged) await recordSave(r.tokensSaved, true, url);
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
    contentHash: contentHashOf(fullMarkdown),
  };
  await putCachedPage(hash, page, !cached);

  const r = await finalize(page, opts, false, false, hash);
  if (!r.unchanged) await recordSave(r.tokensSaved, false, url);
  return r;
}

/** Outline a URL (progressive disclosure step 1) — fetches/caches as needed. */
export async function outline(
  url: string,
): Promise<{ url: string; contentHash: string; items: OutlineItem[] }> {
  const r = await distill(url, {});
  // r.markdown may be clipped/section'd; re-derive from the cached full page.
  const cached = await getCachedPage(urlHash(url));
  const md = cached?.markdown ?? r.markdown;
  return { url, contentHash: r.contentHash, items: outlineOf(md) };
}
