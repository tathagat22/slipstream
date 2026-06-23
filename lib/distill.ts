import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { estimateTokens } from "./tokens";
import { assertHtmlLike, readCapped, safeFetch } from "./security";
import { isLikelySpa, renderJs, rendererAvailable } from "./render";
import { canonicalize } from "./canonical";
import {
  buildSectionIndex,
  diffSectionIndexes,
  extractSection,
  type OutlineItem,
  outlineOf,
  type SectionDelta,
  sectionBodyFromIndex,
} from "./secdiff";
import {
  addVersion,
  type CachedPage,
  claimBodyOwner,
  getAlias,
  getBodyOwner,
  getCachedPage,
  getLowYield,
  getNotes,
  getPriorSectionIndex,
  getVersions,
  markStaleNotes,
  type Note,
  putAlias,
  putCachedPage,
  putLowYield,
  putPriorSectionIndex,
  recordSave,
  urlHash,
  type Version,
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

// Base freshness window; adaptive TTL (Feature 4) derives a per-URL window from
// observed change cadence, clamped between these bounds.
const TTL_MS = 24 * 60 * 60 * 1000;
const TTL_MIN_MS = 60 * 60 * 1000; // 1h — fast-moving pages
const TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7d hard cap — stable references

// Feature 6: a crawl yielding less than this (or an SPA with no renderer) is a
// low-yield dead-end worth remembering so the next agent skips the wasted crawl.
const LOW_YIELD_TOKENS = 50;

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
  unchanged: boolean; // delta short-circuit fired (exact known_hash match)
  contentHash: string;
  notes: Note[];
  renderedWith?: string;
  spaPartial?: boolean;
  fromUrlHash: string;
  alias?: boolean; // served from a content-address alias (Feature 2)
  aliasedFrom?: string; // canonical URL the alias resolved to
  delta?: SectionDelta; // heading-level delta vs a stale known_hash (Feature 3)
  sectionsChanged?: number;
  sectionsTotal?: number;
  lowYield?: boolean; // skipped a known low-yield URL (Feature 6)
};

function contentHashOf(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex").slice(0, 16);
}

// Full 64-hex fingerprint — the dedup key. Wider than the 16-hex display hash so
// cross-URL collisions are cryptographically negligible across a large corpus.
function bodyHashOf(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

// Feature 4: derive a freshness window from how often this URL has actually
// changed. Stable pages live toward the 7d cap; volatile ones get short TTLs.
// Derived purely from internal content hashes — no spoofable client input.
function adaptiveTtlMs(versions: Version[], spaPartial: boolean): number {
  if (spaPartial) return TTL_MS; // never extend partial/SPA captures
  if (versions.length < 3) return TTL_MS; // not enough signal yet
  const times = versions.map((v) => v.at).sort((a, b) => b - a);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < times.length - 1; i++) {
    const d = times[i] - times[i + 1];
    if (d > 0) {
      sum += d;
      n += 1;
    }
  }
  if (n === 0) return TTL_MS;
  const mean = sum / n;
  return Math.max(TTL_MIN_MS, Math.min(TTL_MAX_MS, Math.round(mean / 2)));
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

export type { OutlineItem };

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

  // safeFetch validates the URL + every redirect hop against SSRF and enforces
  // timeout/redirect caps; readCapped enforces the byte cap.
  const res = await safeFetch(url, headers);
  if (res.status === 304) return { status: 304 };
  if (res.status >= 400) {
    throw new Error(`Upstream fetch failed: ${res.status}`);
  }
  assertHtmlLike(res.headers.get("content-type"));
  return {
    status: res.status,
    html: await readCapped(res),
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
}

// Build the heading-level delta result when the caller's known_hash points to a
// retained PRIOR version of this page (Feature 3): return only changed/added
// sections instead of the whole page.
function deltaResult(
  page: CachedPage,
  delta: SectionDelta,
  opts: DistillOptions,
  cacheHit: boolean,
  revalidated: boolean,
  hash: string,
  notes: Note[],
): DistillResult {
  const changedCount = delta.changed.length + delta.added.length;
  const parts: string[] = [
    `_[Slipstream delta · ${changedCount} of ${delta.totalCurrent} sections changed since ${opts.knownHash} · ${delta.unchangedCount} unchanged]_`,
  ];
  for (const s of [...delta.changed, ...delta.added]) parts.push(s.body.trim());
  if (delta.removed.length) {
    parts.push(`_Removed since then: ${delta.removed.map((r) => r.heading).join(", ")}_`);
  }
  const markdown = clipToBudget(parts.join("\n\n"), opts.tokenBudget);
  const distilledTokens = estimateTokens(markdown);
  return {
    url: page.url,
    markdown,
    originalTokens: page.originalTokens,
    distilledTokens,
    tokensSaved: Math.max(0, page.originalTokens - distilledTokens),
    cacheHit,
    revalidated,
    unchanged: false,
    contentHash: page.contentHash ?? contentHashOf(page.markdown),
    notes,
    renderedWith: page.renderedWith,
    spaPartial: page.spaPartial,
    fromUrlHash: hash,
    delta,
    sectionsChanged: changedCount,
    sectionsTotal: delta.totalCurrent,
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

  // Delta short-circuit: the agent already has this EXACT content.
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
      renderedWith: page.renderedWith,
      spaPartial: page.spaPartial,
      fromUrlHash: hash,
    };
    await recordSave(r.tokensSaved, true, page.url);
    return r;
  }

  // Notes, soft-labelled stale if pinned to an older version (Feature 5).
  const notes = markStaleNotes(await getNotes(page.url, 3), fullHash);

  // Partial-match delta: caller's known_hash is a KNOWN PRIOR version we still
  // hold a section index for → return only the changed sections (Feature 3).
  if (opts.knownHash && opts.knownHash !== fullHash && page.index && !opts.section) {
    const prior = await getPriorSectionIndex(hash, opts.knownHash);
    if (prior) {
      const delta = diffSectionIndexes(prior, page.index);
      return deltaResult(page, delta, opts, cacheHit, revalidated, hash, notes);
    }
  }

  // Progressive disclosure: one section only, if asked and found. Prefer the
  // precomputed index (Feature 1); fall back to a live parse for old blobs.
  let body = page.markdown;
  if (opts.section) {
    const sec = page.index
      ? sectionBodyFromIndex(page.index, opts.section)
      : extractSection(page.markdown, opts.section);
    if (sec) body = sec;
  }

  const markdown = clipToBudget(body, opts.tokenBudget);
  const distilledTokens = estimateTokens(markdown);
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
    renderedWith: page.renderedWith,
    spaPartial: page.spaPartial,
    fromUrlHash: hash,
  };
}

// Ensure an older cached blob carries the derived fields newer reads rely on.
function upgrade(page: CachedPage): CachedPage {
  const contentHash = page.contentHash ?? contentHashOf(page.markdown);
  return {
    ...page,
    contentHash,
    bodyHash: page.bodyHash ?? bodyHashOf(page.markdown),
    index: page.index ?? buildSectionIndex(page.markdown, page.createdAt),
  };
}

/**
 * Fetch (or serve from the shared cache) a URL, distilled to token-optimal
 * markdown — content-addressed and shared across all agents. Supports delta
 * fetch (knownHash), heading-level temporal diffs, content-address dedup +
 * mirror collapsing, adaptive TTL, and surfaces collective notes.
 */
export async function distill(
  url: string,
  opts: DistillOptions = {},
): Promise<DistillResult> {
  const { canonicalUrl, fetchUrl, kind } = canonicalize(url);
  const reqHash = urlHash(url);
  const canonHash = urlHash(canonicalUrl);

  // ── Feature 2: alias fast path. A prior agent already proved this URL maps
  // to a body the cache trusts — serve it without crawling.
  const alias = await getAlias(reqHash);
  if (alias) {
    const owner = await getCachedPage(alias.owner);
    if (owner) {
      const ownerUp = upgrade(owner);
      const ttl = ownerUp.ttlMs ?? TTL_MS;
      const fresh = Date.now() - ownerUp.createdAt < ttl;
      if (fresh && ownerUp.bodyHash === alias.bodyHash) {
        const r = await finalize(ownerUp, opts, true, false, alias.owner);
        r.alias = true;
        r.aliasedFrom = ownerUp.url;
        if (!r.unchanged) await recordSave(r.tokensSaved, true, url, true);
        return r;
      }
    }
    // Owner drifted/expired — fall through and re-establish.
  }

  const cached = await getCachedPage(canonHash);
  const ttl = cached?.ttlMs ?? TTL_MS;
  const fresh = cached && Date.now() - cached.createdAt < ttl;
  if (cached && fresh) {
    const page = upgrade(cached);
    const r = await finalize(page, opts, true, false, canonHash);
    if (!r.unchanged) await recordSave(r.tokensSaved, true, url);
    return r;
  }

  // ── Feature 6: skip a known low-yield dead-end instead of paying the crawl.
  if (!cached) {
    const ly = await getLowYield(canonHash);
    if (ly) {
      return {
        url,
        markdown: `_[Slipstream: known low-yield URL — ${ly.reason}. Skipped re-crawl to save tokens; this verdict auto-expires within hours.]_`,
        originalTokens: 0,
        distilledTokens: 0,
        tokensSaved: 0,
        cacheHit: false,
        revalidated: false,
        unchanged: false,
        contentHash: "",
        notes: [],
        fromUrlHash: canonHash,
        lowYield: true,
      };
    }
  }

  const fetched = await crawl(fetchUrl, cached ?? undefined);

  if (fetched.status === 304 && cached) {
    const refreshed: CachedPage = {
      ...upgrade(cached),
      createdAt: Date.now(),
    };
    await putCachedPage(canonHash, refreshed, false);
    const r = await finalize(refreshed, opts, true, true, canonHash);
    if (!r.unchanged) await recordSave(r.tokensSaved, true, url);
    return r;
  }

  const html = fetched.html ?? "";
  const originalTokens = estimateTokens(html);
  let markdown = htmlToDistilledMarkdown(html, url);
  let origTokens = originalTokens;
  let renderedWith: string | undefined;
  let spaPartial = false;

  // SPA handling: static HTML often has no real body. If it looks like an
  // under-rendered SPA, render it properly (Firecrawl) — or flag it as partial.
  if (isLikelySpa(html, originalTokens, estimateTokens(markdown))) {
    if (rendererAvailable()) {
      const r = await renderJs(url);
      if (r && estimateTokens(r.markdown) > estimateTokens(markdown)) {
        markdown = r.markdown;
        origTokens = Math.max(originalTokens, r.rawTokens);
        renderedWith = "firecrawl";
      } else {
        spaPartial = true;
      }
    } else {
      spaPartial = true;
    }
  }

  const distilledTokens = estimateTokens(markdown);
  const bodyHash = bodyHashOf(markdown);
  const contentHash = contentHashOf(markdown);

  // ── Feature 2: same-content collapse (always-on, safe). We actually crawled
  // this URL; if its body is byte-identical to an already-trusted owner, drop
  // the duplicate and alias to the owner. Empty/partial shells never dedup.
  const dedupEligible = distilledTokens >= LOW_YIELD_TOKENS && !spaPartial;
  if (dedupEligible) {
    const ownerHash = await getBodyOwner(bodyHash);
    if (ownerHash && ownerHash !== canonHash) {
      const ownerPage = await getCachedPage(ownerHash);
      if (ownerPage) {
        const ownerUp = upgrade(ownerPage);
        const ownerTtl = ownerUp.ttlMs ?? TTL_MS;
        if (Date.now() - ownerUp.createdAt < ownerTtl && ownerUp.bodyHash === bodyHash) {
          await Promise.all([
            putAlias(canonHash, ownerHash, bodyHash, kind === "mirror" ? "mirror" : "same-content"),
            reqHash !== canonHash
              ? putAlias(reqHash, ownerHash, bodyHash, kind === "mirror" ? "mirror" : "same-content")
              : Promise.resolve(),
          ]);
          const r = await finalize(ownerUp, opts, true, false, ownerHash);
          r.alias = true;
          r.aliasedFrom = ownerUp.url;
          if (!r.unchanged) await recordSave(r.tokensSaved, true, url, true);
          return r;
        }
      }
    }
  }

  // Compute adaptive TTL from the (prior) version ring before writing.
  const priorVersions = await getVersions(canonHash);
  const ttlMs = adaptiveTtlMs(priorVersions, spaPartial);

  const page: CachedPage = {
    url: canonicalUrl,
    markdown,
    originalTokens: origTokens,
    distilledTokens,
    createdAt: Date.now(),
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    contentHash,
    bodyHash,
    index: buildSectionIndex(markdown, Date.now()),
    ttlMs,
    renderedWith,
    spaPartial: spaPartial || undefined,
  };
  await putCachedPage(canonHash, page, !cached);

  // Claim body ownership (first writer wins) and alias the exact requested
  // variant so it short-circuits next time.
  if (dedupEligible) {
    await claimBodyOwner(bodyHash, canonHash);
    if (reqHash !== canonHash) {
      await putAlias(reqHash, canonHash, bodyHash, kind === "mirror" ? "mirror" : "same-content");
    }
  }

  // ── Feature 6: remember a low-yield dead-end so the next agent skips it.
  if (spaPartial) {
    await putLowYield(canonHash, "SPA detected with no public content (no JS renderer)");
  } else if (distilledTokens < LOW_YIELD_TOKENS) {
    await putLowYield(canonHash, "near-empty extraction (<50 tokens)");
  }

  // Version snapshot + Feature 3 retention: when the content changed and this
  // URL has demonstrably changed before, retain the PRIOR section index so a
  // later agent inheriting the old hash gets a heading-level delta.
  const changed = !cached || cached.contentHash !== contentHash;
  if (changed) {
    if (cached?.index && cached.contentHash) {
      await putPriorSectionIndex(canonHash, cached.contentHash, cached.index);
    }
    await addVersion(canonHash, contentHash, page.createdAt);
  }

  const r = await finalize(page, opts, false, false, canonHash);
  if (!r.unchanged) await recordSave(r.tokensSaved, false, url);
  return r;
}

/** Outline a URL (progressive disclosure step 1) — fetches/caches as needed. */
export async function outline(
  url: string,
): Promise<{ url: string; contentHash: string; items: OutlineItem[] }> {
  const r = await distill(url, {});
  // Prefer the precomputed index (Feature 1); fall back to a live parse.
  const cached = await getCachedPage(urlHash(canonicalize(url).canonicalUrl));
  const items = cached?.index?.outline ?? outlineOf(cached?.markdown ?? r.markdown);
  return { url, contentHash: r.contentHash, items };
}
