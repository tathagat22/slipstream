// Prewarm backtest — does an origin's PUBLISH signal reliably PRECEDE the agent
// demand for the changed docs? If yes, demand-gated publish-push pre-distillation
// (the one idea that survived the discovery engine) is worth building. If not, kill it.
//
// READ-ONLY. Touches only GET/LRANGE/ZRANGE on the live cache + free public
// release APIs (npm / PyPI / GitHub). Writes nothing.
//
// Usage:
//   node scripts/prewarm-backtest.mjs [--window=24h] [--top=40]
// Env: UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN). Optional GITHUB_TOKEN
// to lift the GitHub releases rate limit.

import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";

// ── args ──────────────────────────────────────────────────────────────────────
const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : d;
};
const windowH = parseHours(arg("window", "24h"));
const TOP = Number(arg("top", "40"));

function parseHours(s) {
  const m = /^(\d+)([hd])$/.exec(s);
  if (!m) return 24;
  return Number(m[1]) * (m[2] === "d" ? 24 : 1);
}

// ── redis (read-only) ─────────────────────────────────────────────────────────
const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error(
    "✗ No Redis creds. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN\n" +
      "  (or KV_REST_API_URL + KV_REST_API_TOKEN). Pull them with: vercel env pull",
  );
  process.exit(1);
}
const redis = new Redis({ url, token });

// Mirror of lib/cache.ts key scheme + url normalization (kept in sync by hand).
const urlHash = (u) => {
  let n = u.trim();
  try {
    const x = new URL(u);
    x.hash = "";
    if (x.pathname.length > 1 && x.pathname.endsWith("/")) x.pathname = x.pathname.slice(0, -1);
    n = x.toString();
  } catch {}
  return createHash("sha256").update(n).digest("hex").slice(0, 32);
};
const domainOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
};

// ── release-feed resolution: hot doc-set → a free public release timeline ──────
// Curated where the docs domain != package name; generic guesses otherwise.
const CURATED = {
  "react.dev": ["npm", "react"],
  "nextjs.org": ["npm", "next"],
  "vuejs.org": ["npm", "vue"],
  "svelte.dev": ["npm", "svelte"],
  "tailwindcss.com": ["npm", "tailwindcss"],
  "nodejs.org": ["github", "nodejs/node"],
  "fastapi.tiangolo.com": ["pypi", "fastapi"],
  "docs.djangoproject.com": ["pypi", "django"],
  "flask.palletsprojects.com": ["pypi", "flask"],
  "numpy.org": ["pypi", "numpy"],
  "pytorch.org": ["pypi", "torch"],
  "docs.pydantic.dev": ["pypi", "pydantic"],
  "kit.svelte.dev": ["npm", "@sveltejs/kit"],
  "vitejs.dev": ["npm", "vite"],
  "expressjs.com": ["npm", "express"],
};

function resolveReleaseSource(docset, sampleUrl) {
  const domain = docset.split("/")[0];
  if (CURATED[domain]) return CURATED[domain];
  try {
    const u = new URL(sampleUrl);
    if (u.hostname.endsWith("github.com")) {
      const [org, repo] = u.pathname.split("/").filter(Boolean);
      if (org && repo) return ["github", `${org}/${repo}`];
    }
    if (u.hostname.endsWith("npmjs.com")) {
      const i = u.pathname.split("/").filter(Boolean);
      const pkg = i[0] === "package" ? i.slice(1).join("/") : i[0];
      if (pkg) return ["npm", pkg];
    }
    if (u.hostname.endsWith("pypi.org")) {
      const i = u.pathname.split("/").filter(Boolean);
      if (i[0] === "project" && i[1]) return ["pypi", i[1]];
    }
  } catch {}
  return null; // long-tail HTML/blog: no machine-readable release signal
}

async function fetchReleases([type, id]) {
  try {
    if (type === "npm") {
      const r = await fetch(`https://registry.npmjs.org/${id.replace("/", "%2F")}`);
      if (!r.ok) return [];
      const j = await r.json();
      return Object.entries(j.time ?? {})
        .filter(([k]) => !["created", "modified"].includes(k))
        .map(([, t]) => Date.parse(t))
        .filter(Boolean);
    }
    if (type === "pypi") {
      const r = await fetch(`https://pypi.org/pypi/${id}/json`);
      if (!r.ok) return [];
      const j = await r.json();
      return Object.values(j.releases ?? {})
        .flat()
        .map((f) => Date.parse(f.upload_time_iso_8601))
        .filter(Boolean);
    }
    if (type === "github") {
      const h = process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {};
      const r = await fetch(`https://api.github.com/repos/${id}/releases?per_page=100`, {
        headers: { ...h, "User-Agent": "slipstream-backtest" },
      });
      if (!r.ok) return [];
      const j = await r.json();
      return (Array.isArray(j) ? j : []).map((x) => Date.parse(x.published_at)).filter(Boolean);
    }
  } catch {}
  return [];
}

// ── load demand + change history from the cache ───────────────────────────────
async function loadDemandIndex() {
  const raw = await redis.zrange("slip:demand:freq", 0, TOP - 1, { rev: true, withScores: true });
  const hot = [];
  for (let i = 0; i < raw.length; i += 2) hot.push({ docset: String(raw[i]), count: Number(raw[i + 1]) });
  if (hot.length) return { hot, source: "demand-freq (live query counts)" };
  // bootstrap: cumulative tokens-saved per domain is the only hot-head proxy that
  // exists before demand telemetry accrues.
  const dom = await redis.zrange("slip:domains", 0, TOP - 1, { rev: true, withScores: true });
  for (let i = 0; i < dom.length; i += 2)
    hot.push({ docset: String(dom[i]), count: Number(dom[i + 1]) });
  return { hot, source: "slip:domains (BOOTSTRAP — tokens-saved proxy; re-run after demand accrues)" };
}

async function loadDemandEvents() {
  const raw = await redis.lrange("slip:demand:recent", 0, 1999);
  return raw
    .map((v) => (typeof v === "string" ? safeJSON(v) : v))
    .filter(Boolean)
    .map((e) => ({ ...e, docset: docsetFromUrl(e.url) }));
}
const safeJSON = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
function docsetFromUrl(u) {
  try {
    const x = new URL(u);
    const seg = x.pathname.split("/").filter(Boolean)[0];
    return seg ? `${domainOf(u)}/${seg}` : domainOf(u);
  } catch {
    return domainOf(u);
  }
}

// observed content-change timestamps for the urls we've seen in a doc-set
async function changeTimesForUrls(urls) {
  const times = [];
  for (const u of [...new Set(urls)].slice(0, 25)) {
    const raw = await redis.lrange(`slip:ver:${urlHash(u)}`, 0, 19);
    for (const v of raw) {
      const o = typeof v === "string" ? safeJSON(v) : v;
      if (o?.at) times.push(o.at);
    }
  }
  return times.sort((a, b) => a - b);
}

// ── run ───────────────────────────────────────────────────────────────────────
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const hours = (ms) => (ms / 3_600_000).toFixed(1);

console.log(`\n▸ Prewarm backtest  ·  window=${windowH}h  ·  top=${TOP} doc-sets\n`);

const { hot, source } = await loadDemandIndex();
const demandEvents = await loadDemandEvents();
console.log(`Hot-head source : ${source}`);
console.log(`Hot doc-sets    : ${hot.length}`);
console.log(`Demand events   : ${demandEvents.length} (with urls + timestamps)`);
if (demandEvents.length < 50)
  console.log(
    `  ⚠ demand log thin → LEAD-TIME/PRECISION are bootstrap-grade. Re-run in a few\n` +
      `    weeks once slip:demand:recent fills for real-data fidelity.`,
  );

const W = windowH * 3_600_000;
let covered = 0;
const leadToDemand = [];
const leadToChange = [];
let releasesOnHot = 0;
let releasesFollowedByDemand = 0;

for (const { docset } of hot) {
  const events = demandEvents.filter((e) => e.docset === docset);
  const sampleUrl = events[0]?.url ?? `https://${docset.split("/")[0]}/`;
  const src = resolveReleaseSource(docset, sampleUrl);
  if (!src) continue; // no release feed → stays lazy, bounds value (reported)
  const releases = await fetchReleases(src);
  if (!releases.length) continue;
  covered++;

  const demandTimes = events.map((e) => e.at).sort((a, b) => a - b);
  const changeTimes = await changeTimesForUrls(events.map((e) => e.url));

  for (const R of releases) {
    // only score releases recent enough to be inside our observation window
    if (Date.now() - R > 120 * 86_400_000) continue;
    releasesOnHot++;
    const d = demandTimes.find((t) => t > R && t - R <= W);
    if (d) {
      releasesFollowedByDemand++;
      leadToDemand.push(d - R);
    }
    const c = changeTimes.find((t) => t > R && t - R <= W);
    if (c) leadToChange.push(c - R);
  }
}

console.log(`\n── Coverage ──`);
console.log(`Hot doc-sets with a release feed : ${covered}/${hot.length}`);
console.log(`  (the rest are long-tail HTML with no release signal → they stay lazy)`);

console.log(`\n── (a) Lead time: does a release PRECEDE demand? ──`);
if (leadToDemand.length) {
  console.log(`Releases followed by real demand within ${windowH}h : ${leadToDemand.length}`);
  console.log(
    `  lead time (release→first query)  p50=${hours(pct(leadToDemand, 50))}h  ` +
      `p90=${hours(pct(leadToDemand, 90))}h`,
  );
} else {
  console.log(`  no release→demand pairs in window (demand log too thin or releases too old)`);
}
if (leadToChange.length)
  console.log(
    `Releases followed by an OBSERVED content change within ${windowH}h : ${leadToChange.length} ` +
      `(p50=${hours(pct(leadToChange, 50))}h) — confirms releases move the docs`,
  );

console.log(`\n── (b) Gate precision ──`);
const precision = releasesOnHot ? releasesFollowedByDemand / releasesOnHot : 0;
console.log(`Releases on hot doc-sets (≤120d)        : ${releasesOnHot}`);
console.log(`…that drew real demand within ${windowH}h    : ${releasesFollowedByDemand}`);
console.log(`Precision (would-prewarm hit rate)     : ${(precision * 100).toFixed(1)}%`);
console.log(`  → 1 − precision = speculative distills wasted (bounded by the budget cap)`);

console.log(`\n── Verdict ──`);
const verdict =
  demandEvents.length < 50
    ? "INCONCLUSIVE — demand telemetry too thin. Keep the demand log running; re-run later."
    : precision >= 0.3 && leadToDemand.length >= 10
      ? "BUILD — releases reliably precede demand on the hot head, precision clears the bar."
      : "KILL (for now) — demand doesn't reliably follow releases / precision too low to justify infra.";
console.log(verdict + "\n");
