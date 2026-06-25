"use client";

/**
 * The Living Web Changelog — the deepest moat, shown not told. A heading-level
 * diff of a page that moved on: only the changed sections are returned, the rest
 * stay at ~0 tokens. Illustrative example of a real cached_fetch(known_hash) delta.
 */

type Line =
  | { k: "ctx"; t: string }
  | { k: "add"; t: string }
  | { k: "del"; t: string }
  | { k: "fold"; t: string };

const LINES: Line[] = [
  { k: "ctx", t: "## Rate limits" },
  { k: "del", t: "Tier 1 — 50 requests / minute" },
  { k: "add", t: "Tier 1 — 60 requests / minute" },
  { k: "del", t: "Burst traffic is not supported." },
  { k: "add", t: "Burst up to 2× the limit for 10s windows." },
  { k: "fold", t: "## Authentication · unchanged" },
  { k: "fold", t: "## Errors · unchanged" },
  { k: "ctx", t: "## Streaming" },
  { k: "add", t: "Server-sent events now include a `usage` delta frame." },
  { k: "fold", t: "13 more sections · unchanged · 0 tokens" },
];

export default function ChangelogDemo() {
  return (
    <section className="changelog reveal" aria-label="Living Web Changelog example">
      <span className="eyebrow">The Living Web Changelog</span>
      <h2>What changed since the version you cited.</h2>
      <p className="hivesub">
        When a page moves on, the first agent to re-crawl computes the per-section
        delta <strong>once</strong>. Every later agent that passed the old{" "}
        <code>known_hash</code> inherits only the changed sections — for{" "}
        <strong>~0 tokens</strong>. No stateless fetcher can answer “what changed
        since the version you cited.”
      </p>

      <div className="diff">
        <div className="diffhead">
          <span className="diffdom">
            <span className="dot" /> docs.example.com/api/rate-limits
          </span>
          <span className="diffbadge">3 of 18 sections changed · ~2,400 tokens saved</span>
        </div>
        <div className="diffbody">
          {LINES.map((l, i) => (
            <div className={`dl ${l.k}`} key={i}>
              <span className="gutter">
                {l.k === "add" ? "+" : l.k === "del" ? "–" : ""}
              </span>
              <span className="dt">{l.t}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
