import { createHash } from "node:crypto";
import { estimateTokens } from "./tokens";

// ── Section parsing: the single source of truth ──────────────────────────────
// Distilled markdown is split into heading-delimited sections. A per-section
// full sha256 fingerprint is the substrate that turns the shared cache into a
// content-addressed changelog of the live web: a *different* agent can pass back
// an old contentHash and inherit "only these 3 of 18 sections changed".

export type OutlineItem = { heading: string; level: number; tokens: number };

export type RawSection = { heading: string; level: number; body: string };

export type SectionEntry = {
  heading: string; // e.g. "Installation" or "(intro)"
  level: number; // 0 for (intro), 1..6 for h1..h6
  body: string; // the section's distilled markdown (heading line + content)
  sha256: string; // FULL 64-hex sha256 of `body` — stable cross-agent fingerprint
  tokens: number; // estimateTokens(body)
};

export type SectionIndex = {
  v: 1; // schema version, so future readers can migrate/reject stale shapes
  outline: OutlineItem[]; // == legacy outlineOf() output (level<=3, no intro)
  sections: SectionEntry[]; // ALL sections incl. (intro), in document order
  built: number; // ms when computed
};

// Bounds — keep a single page blob's embedded index from exploding. The full
// markdown is already stored once in page.markdown; the index roughly doubles
// per-section text in the worst case, so these caps keep a blob comfortably
// under the upstream MAX_BYTES (3MB) raw-input cap.
export const SECTION_INDEX_MAX_SECTIONS = 50;
export const SECTION_INDEX_MAX_BYTES = 600_000;

/** Split distilled markdown into (heading, level, body) sections by ATX headings. */
export function splitSections(markdown: string): RawSection[] {
  const lines = markdown.split("\n");
  const sections: RawSection[] = [];
  let cur: RawSection = { heading: "(intro)", level: 0, body: "" };
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

/** Extract one section (heading match, parent-carries-children) from raw markdown. */
export function extractSection(markdown: string, query: string): string | null {
  const q = query.toLowerCase().trim();
  const lines = markdown.split("\n");
  const headings = lines
    .map((line, i) => {
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      return m ? { i, level: m[1].length, text: m[2].trim().toLowerCase() } : null;
    })
    .filter((h): h is { i: number; level: number; text: string } => h !== null);

  const start =
    headings.find((h) => h.text === q) ?? headings.find((h) => h.text.includes(q));
  if (!start) return null;

  // Include everything until the next heading of the same or higher level —
  // so a parent section carries its subsections with it.
  const next = headings.find((h) => h.i > start.i && h.level <= start.level);
  const body = lines.slice(start.i, next ? next.i : undefined).join("\n");
  return body.trim();
}

const fullSha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Precompute the bounded section index for a distilled markdown body. Pure CPU,
 * run ONCE on the cache write path; returns undefined if the page is over the
 * section-count or byte caps (callers then fall back to the live parse path).
 */
export function buildSectionIndex(
  markdown: string,
  builtAt: number,
): SectionIndex | undefined {
  const raw = splitSections(markdown);
  if (raw.length > SECTION_INDEX_MAX_SECTIONS) return undefined;

  let totalBytes = 0;
  const sections: SectionEntry[] = [];
  for (const s of raw) {
    totalBytes += Buffer.byteLength(s.body, "utf8");
    if (totalBytes > SECTION_INDEX_MAX_BYTES) return undefined;
    sections.push({
      heading: s.heading,
      level: s.level,
      body: s.body,
      sha256: fullSha(s.body),
      tokens: estimateTokens(s.body),
    });
  }

  // Derive the outline inline from sections to keep ONE split per write.
  const outline: OutlineItem[] = sections
    .filter((s) => s.heading !== "(intro)" && s.level <= 3)
    .map((s) => ({ heading: s.heading, level: s.level, tokens: s.tokens }));

  return { v: 1, outline, sections, built: builtAt };
}

/**
 * Resolve one section's body from a stored index, reproducing extractSection's
 * parent-carries-children semantics from stored entries (no re-parse). Returns
 * null when no heading matches.
 */
export function sectionBodyFromIndex(
  index: SectionIndex,
  query: string,
): string | null {
  const q = query.toLowerCase().trim();
  const secs = index.sections;
  let startIdx = secs.findIndex((s) => s.heading.toLowerCase().trim() === q);
  if (startIdx < 0) {
    startIdx = secs.findIndex((s) => s.heading.toLowerCase().trim().includes(q));
  }
  if (startIdx < 0) return null;

  const startLevel = secs[startIdx].level;
  let endIdx = startIdx + 1;
  while (endIdx < secs.length && secs[endIdx].level > startLevel) endIdx += 1;

  const body = secs
    .slice(startIdx, endIdx)
    .map((s) => s.body)
    .join("");
  return body.trim();
}

// ── Heading-level diff (the flagship substrate) ──────────────────────────────

export type SectionDelta = {
  changed: SectionEntry[]; // sections whose hash differs (present in both, body moved)
  added: SectionEntry[]; // headings present now but not in the prior version
  removed: { heading: string; level: number }[]; // headings gone since the prior version
  unchangedCount: number;
  totalCurrent: number;
};

/**
 * Diff two section indexes at heading granularity. Matching is by heading text
 * (normalized); a heading present in both with a differing sha256 is "changed".
 * Pure — no Redis, no network.
 */
export function diffSectionIndexes(
  prev: SectionIndex,
  cur: SectionIndex,
): SectionDelta {
  const norm = (h: string) => h.toLowerCase().trim();
  const prevByHeading = new Map(prev.sections.map((s) => [norm(s.heading), s]));
  const curHeadings = new Set(cur.sections.map((s) => norm(s.heading)));

  const changed: SectionEntry[] = [];
  const added: SectionEntry[] = [];
  let unchangedCount = 0;
  for (const s of cur.sections) {
    if (s.heading === "(intro)" && !prevByHeading.has("(intro)")) {
      added.push(s);
      continue;
    }
    const prior = prevByHeading.get(norm(s.heading));
    if (!prior) added.push(s);
    else if (prior.sha256 !== s.sha256) changed.push(s);
    else unchangedCount += 1;
  }

  const removed = prev.sections
    .filter((s) => !curHeadings.has(norm(s.heading)))
    .map((s) => ({ heading: s.heading, level: s.level }));

  return {
    changed,
    added,
    removed,
    unchangedCount,
    totalCurrent: cur.sections.length,
  };
}
