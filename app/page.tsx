"use client";

import { useEffect, useState } from "react";

type Stats = {
  tokensSaved: number;
  hits: number;
  misses: number;
  pagesCached: number;
  hitRate: number;
  shared: boolean;
};

function useStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/stats", { cache: "no-store" });
        const j = (await r.json()) as Stats;
        if (alive) setStats(j);
      } catch {
        /* ignore transient errors */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return stats;
}

const mcpSnippet = `{
  "mcpServers": {
    "slipstream": {
      "url": "https://YOUR-DEPLOYMENT.vercel.app/api/mcp"
    }
  }
}`;

export default function Home() {
  const stats = useStats();
  const saved = stats?.tokensSaved ?? 0;

  return (
    <main className="wrap">
      <span className="eyebrow">Shared cache for AI agents</span>
      <h1>Every agent makes the web cheaper for the next.</h1>
      <p className="lede">
        Slipstream is a <strong>shared distillation cache</strong> for AI agents,
        served over MCP. The first agent to hit a URL pays the crawl. Every agent
        after drafts in its slipstream — getting clean, token-optimized markdown
        for <strong>~90% fewer tokens</strong>.
      </p>

      <section className="counter">
        <div className="label">Tokens saved for agents worldwide</div>
        <div className="big">{saved.toLocaleString()}</div>
        <div className="sub">
          {stats
            ? `${(stats.hitRate * 100).toFixed(1)}% cache hit rate · live`
            : "connecting…"}
        </div>
        <div className="stat-row">
          <div className="stat">
            <div className="n">{(stats?.pagesCached ?? 0).toLocaleString()}</div>
            <div className="k">pages cached</div>
          </div>
          <div className="stat">
            <div className="n">{(stats?.hits ?? 0).toLocaleString()}</div>
            <div className="k">cache hits</div>
          </div>
          <div className="stat">
            <div className="n">{(stats?.misses ?? 0).toLocaleString()}</div>
            <div className="k">cold crawls</div>
          </div>
        </div>
      </section>

      <h2>How it works</h2>
      <div className="how">
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
            On a miss, Slipstream clean-crawls the page and distills it to
            token-optimal markdown — once, for everyone.
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

      <h2>Add it to your agent (30 seconds)</h2>
      <pre>{mcpSnippet}</pre>

      <footer>
        <span className="dot" />
        Slipstream · a shared cache that gets cheaper for everyone the more it’s
        used.
      </footer>
    </main>
  );
}
