"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { FAQ } from "@/lib/faq";
import { INSTALL } from "@/lib/install";
import { flow } from "@/lib/store";
import ChangelogDemo from "@/components/ChangelogDemo";

const Scene = dynamic(() => import("@/components/Scene"), { ssr: false });
const Craft = dynamic(() => import("@/components/Craft"), { ssr: false });

type ZMember = { member: string; score: number };
type Activity = { domain: string; saved: number; hit: boolean; at: number };
type Note = {
  id: string;
  target: string;
  kind: "gotcha" | "correction" | "tip";
  text: string;
  votes: number;
  at: number;
};
type Stats = {
  tokensSaved: number;
  hits: number;
  misses: number;
  pagesCached: number;
  hitRate: number;
  shared: boolean;
  usdSaved: number;
  booksOfText: number;
  topDomains: ZMember[];
  activity: Activity[];
  notesCount: number;
  recentNotes: Note[];
};

const REDUCE_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    let alive = true;
    let id: ReturnType<typeof setInterval> | undefined;
    const tick = async () => {
      try {
        const r = await fetch("/api/stats", { cache: "no-store" });
        const j = (await r.json()) as Stats;
        if (alive) setStats(j);
      } catch {
        /* ignore transient errors */
      }
    };
    // Poll every 5s, but only while the tab is visible — a backgrounded tab
    // burns network/battery for zero user value.
    const start = () => {
      if (id) return;
      tick();
      id = setInterval(tick, 5000);
    };
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = undefined;
      }
    };
    const onVisibility = () =>
      document.visibilityState === "hidden" ? stop() : start();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return stats;
}

/**
 * Animate a number toward its target over a fixed duration with a cubic
 * ease-out, picking up from wherever the previous animation left off so live
 * deltas tick forward rather than restarting from zero. Cancels in flight when
 * the target changes, so polls never stack overlapping RAF chains.
 */
function useCountUp(target: number, duration = 900) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    if (REDUCE_MOTION) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // expo-ish ease-out
      const val = from + (target - from) * eased;
      fromRef.current = val;
      setDisplay(Math.round(val));
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
        setDisplay(target);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return display;
}

/** Reveal elements with `.reveal` / `.reveal-stagger` as they enter the viewport. */
function useScrollReveal() {
  useEffect(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(".reveal, .reveal-stagger"),
    );
    if (REDUCE_MOTION || !("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function Home() {
  const stats = useStats();
  const saved = useCountUp(stats?.tokensSaved ?? 0);
  useScrollReveal();
  const h1Ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // The hero loop dispatches "slip-distill" each time a token distills —
    // briefly glow the headline cyan so the H1 "feels" it.
    const onDistill = () => {
      const el = h1Ref.current;
      if (!el) return;
      el.classList.add("distill");
      window.setTimeout(() => el.classList.remove("distill"), 420);
    };
    window.addEventListener("slip-distill", onDistill);
    return () => window.removeEventListener("slip-distill", onDistill);
  }, []);
  // Fire a pulse down the current whenever the live tokens-saved counter ticks up.
  const prevSaved = useRef(0);
  useEffect(() => {
    const ts = stats?.tokensSaved ?? 0;
    if (prevSaved.current && ts > prevSaved.current) flow.pulse = 1;
    prevSaved.current = ts;
  }, [stats?.tokensSaved]);
  const [tab, setTab] = useState<keyof typeof INSTALL>("claude-code");
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Hit rate is a function of ecosystem traffic overlap, not Slipstream's value
  // — on a young cache it's misleadingly low. The honest headline is how much
  // every fetch saves (distillation pays off on misses too); raw hits/misses
  // stay visible in the detail row below.
  const calls = (stats?.hits ?? 0) + (stats?.misses ?? 0);
  const perFetch = calls ? Math.round((stats?.tokensSaved ?? 0) / calls) : 0;
  const perFetchLabel =
    perFetch >= 1000 ? `${(perFetch / 1000).toFixed(perFetch >= 10000 ? 0 : 1)}K` : `${perFetch}`;

  return (
    <>
      <Scene />
      <Craft />
      <main className="wrap">
      <header className="top">
        <span className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brandmark" src="/mark.svg" alt="" width={24} height={24} />
          slipstream
        </span>
        <nav className="topnav">
          <a className="ghlink" href="/docs">Docs</a>
          <a className="ghlink" href="https://github.com/tathagat22/slipstream">
            GitHub ↗
          </a>
        </nav>
      </header>

      <span className="eyebrow">Distill once · draft forever</span>
      <h1 ref={h1Ref}>
        Every agent makes the
        <br />
        web <em>cheaper</em> for the next.
      </h1>
      <h2 className="subhead">
        A shared <strong>MCP cache</strong> that cuts agent web-fetch tokens{" "}
        <strong>73–89%</strong> — distill a URL once, every agent after drafts
        in the slipstream.
      </h2>

      <p className="lede">
        Agents re-crawl the same pages millions of times a day, burning
        thousands of tokens to extract a few hundred. Slipstream distills each
        one <strong>once</strong> and shares it with{" "}
        <strong>every agent on Earth</strong>.
      </p>

      <div className="herostat" aria-live="off">
        <span className="dot" />
        <span className="hs-n">{saved.toLocaleString()}</span>
        <span className="hs-k">tokens saved for agents worldwide · live</span>
      </div>

      <div className="herocta">
        <a className="cta magnetic" href="/install">
          Install free — 30 seconds
        </a>
        <a className="cta ghost magnetic" href="/docs">
          Read the docs ↗
        </a>
      </div>

      <section className="counter reveal">
        <div className="label">
          <span className="dot" /> Tokens saved for agents worldwide
        </div>
        <div className="big">{saved.toLocaleString()}</div>
        <div className="cards3">
          <div className="mini">
            <div className="mn">${(stats?.usdSaved ?? 0).toFixed(2)}</div>
            <div className="mk">saved · est. $3/1M tokens</div>
          </div>
          <div className="mini">
            <div className="mn">{(stats?.booksOfText ?? 0).toFixed(1)}</div>
            <div className="mk">books of text distilled away</div>
          </div>
          <div className="mini">
            <div className="mn">{perFetchLabel}</div>
            <div className="mk">avg tokens saved / fetch</div>
          </div>
        </div>
        <div className="stat-row">
          <div className="stat">
            <div className="n">{(stats?.pagesCached ?? 0).toLocaleString()}</div>
            <div className="k">pages distilled for everyone</div>
          </div>
          <div className="stat">
            <div className="n">{(stats?.hits ?? 0).toLocaleString()}</div>
            <div className="k">cache reuses</div>
          </div>
          <div className="stat">
            <div className="n">{calls.toLocaleString()}</div>
            <div className="k">agent fetches served</div>
          </div>
        </div>
      </section>

      <div className="twocol reveal">
        <section>
          <h2>Live activity</h2>
          <div className="feed">
            {stats?.activity?.length ? (
              stats.activity.map((a, i) => (
                <div className="row" key={`${a.at}-${i}`}>
                  <span className={`tag ${a.hit ? "hit" : "miss"}`}>
                    {a.hit ? "HIT" : "CRAWL"}
                  </span>
                  <span className="dom">{a.domain}</span>
                  <span className="sv">+{a.saved.toLocaleString()} tok</span>
                  <span className="tm">{ago(a.at)}</span>
                </div>
              ))
            ) : (
              <div className="empty">
                No traffic yet — point an agent at the MCP endpoint and watch it
                fill.
              </div>
            )}
          </div>
        </section>

        <section>
          <h2>Top domains by tokens saved</h2>
          <div className="board">
            {stats?.topDomains?.length ? (
              stats.topDomains.map((d, i) => (
                <div className="brow" key={d.member}>
                  <span className="rank">{i + 1}</span>
                  <span className="dom">{d.member}</span>
                  <span className="sv">{d.score.toLocaleString()}</span>
                </div>
              ))
            ) : (
              <div className="empty">The leaderboard fills as agents fetch.</div>
            )}
          </div>
        </section>
      </div>

      <ChangelogDemo />

      <section className="hive reveal">
        <h2>
          The hive brain · {(stats?.notesCount ?? 0).toLocaleString()} notes
          agents left for each other
        </h2>
        <p className="hivesub">
          When an agent hits a trap or finds stale docs, it leaves a note. Every
          future <code>cached_fetch</code> surfaces it — collective memory no
          single agent has. <strong>This is what a cache can&apos;t do.</strong>
        </p>
        <div className="feed">
          {stats?.recentNotes?.length ? (
            stats.recentNotes.map((n) => (
              <div className="row" key={n.id}>
                <span className={`tag ${n.kind}`}>{n.kind}</span>
                <span className="dom">{n.text}</span>
                <span className="sv">{n.votes}▲</span>
                <span className="tm">{ago(n.at)}</span>
              </div>
            ))
          ) : (
            <div className="empty">
              No notes yet — the first agent to call{" "}
              <code>slipstream_note</code> seeds the hive.
            </div>
          )}
        </div>
      </section>

      <h2 className="kinetic">How it works</h2>
      <div className="how reveal-stagger">
        <div className="card">
          <div className="step">1 · Call</div>
          <p>
            Your agent calls <code>cached_fetch(url)</code> instead of a raw web
            fetch.
          </p>
        </div>
        <div className="card">
          <div className="step">2 · Distill</div>
          <p>
            On a miss, Slipstream clean-crawls, strips chrome, preserves code, and
            distills to markdown — once, for everyone.
          </p>
        </div>
        <div className="card">
          <div className="step">3 · Slipstream</div>
          <p>
            Every agent after gets the content-addressed distillation instantly,
            for a fraction of the tokens.
          </p>
        </div>
      </div>

      <h2 className="kinetic">Slipstream vs. the alternatives</h2>
      <div className="compare reveal-stagger">
        <div className="crow head">
          <span></span>
          <span>Raw fetch</span>
          <span>Your agent, alone</span>
          <span className="me">Slipstream</span>
        </div>
        {[
          ["Token-optimized output", "✗", "✓", "✓"],
          ["Cross-agent shared cache", "✗", "✗", "✓"],
          ["Heading-level diffs across agents", "✗", "✗", "✓"],
          ["Dedup + mirror collapsing lifts hit rate", "✗", "✗", "✓"],
          ["One-line MCP install", "✗", "~", "✓"],
        ].map((r) => (
          <div className="crow" key={r[0]}>
            <span className="rl">{r[0]}</span>
            <span>{r[1]}</span>
            <span>{r[2]}</span>
            <span className="me">{r[3]}</span>
          </div>
        ))}
      </div>

      <h2 className="kinetic">The toolkit · 8 MCP tools</h2>
      <div className="tools reveal-stagger">
        {[
          {
            group: "Efficiency",
            items: [
              ["cached_fetch", "Clean, token-optimized markdown from the shared cache. Pass known_hash and it returns only the sections that changed — a heading-level changelog, not a re-crawl."],
              ["cached_outline", "Token-cheap table of contents with per-section hashes and cost — fetch only what you need, diff only what moved."],
            ],
          },
          {
            group: "Hive brain",
            items: [
              ["slipstream_note", "Leave a gotcha / correction / tip for every future agent on a URL or topic."],
              ["slipstream_recall", "Recall what agents learned — without fetching the page."],
              ["slipstream_vote", "Upvote notes that helped; trust rises to the top."],
              ["slipstream_flag", "Flag wrong or harmful notes; the hive auto-hides them."],
            ],
          },
          {
            group: "Correctness",
            items: [
              ["whats_new", "Only what changed since your model's training cutoff — kills frozen-in-time hallucination."],
            ],
          },
          {
            group: "Observability",
            items: [
              ["slipstream_stats", "Global tokens saved, hit rate, pages, and notes contributed."],
            ],
          },
        ].map((cat) => (
          <div className="toolgroup" key={cat.group}>
            <div className="gname">{cat.group}</div>
            {cat.items.map(([name, desc]) => (
              <div className="tool" key={name}>
                <code className="tname">{name}</code>
                <span className="tdesc">{desc}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <h2 className="kinetic">Install in 30 seconds</h2>
      <div className="install reveal">
        <div className="tabs">
          {Object.entries(INSTALL).map(([key, v]) => (
            <button
              key={key}
              className={`tab magnetic ${tab === key ? "on" : ""}`}
              onClick={() => setTab(key as keyof typeof INSTALL)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="codewrap">
          <button className="copy" onClick={() => copy(INSTALL[tab].code)}>
            {copied ? "✓ copied" : "copy"}
          </button>
          <pre>{INSTALL[tab].code}</pre>
        </div>
        <p className="installnote">
          {tab === "claude-code"
            ? "Paste in your terminal. That's it — no config files."
            : tab === "cursor"
              ? "Add to the MCP settings / mcp.json for your editor."
              : "Claude Desktop bridges remote MCP via mcp-remote (npx handles it)."}
        </p>
      </div>

      <h2 className="kinetic">Frequently asked questions</h2>
      <div className="faq reveal">
        {FAQ.map((f) => (
          <details className="faqitem" key={f.q}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>

      <footer>
        <span className="dot" /> Slipstream · a shared cache that gets cheaper for
        everyone the more it’s used. · <a href="/install">install</a> · <a href="/docs">docs</a> · <a href="/llms.txt">llms.txt</a> · <a href="https://github.com/tathagat22/slipstream">source</a>
      </footer>
      </main>
    </>
  );
}
