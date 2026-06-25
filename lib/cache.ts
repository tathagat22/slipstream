import { createHash, randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { normalizeForDedup } from "./security";
import type { SectionIndex } from "./secdiff";

// ── Storage backend ─────────────────────────────────────────────────────────
// Production: Upstash Redis (shared across every serverless invocation = a real
// cross-agent cache). Local/dev with no env: an in-process Map so it just runs.

type ZMember = { member: string; score: number };

type Store = {
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
  incrBy(key: string, amount: number): Promise<number>;
  get(key: string): Promise<number>;
  pushCapped(key: string, value: unknown, max: number): Promise<void>;
  listRange<T>(key: string, count: number): Promise<T[]>;
  zincr(key: string, member: string, amount: number): Promise<void>;
  ztop(key: string, count: number): Promise<ZMember[]>;
  incrTtl(key: string, ttlSec: number): Promise<number>;
  setJSONNX(key: string, value: unknown, ttlSec: number): Promise<boolean>;
  setJSONTtl(key: string, value: unknown, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
};

function makeRedisStore(redis: Redis): Store {
  return {
    async getJSON<T>(key: string) {
      return (await redis.get<T>(key)) ?? null;
    },
    async setJSON(key, value) {
      await redis.set(key, value);
    },
    async incrBy(key, amount) {
      return redis.incrby(key, Math.round(amount));
    },
    async get(key) {
      return (await redis.get<number>(key)) ?? 0;
    },
    async pushCapped(key, value, max) {
      await redis.lpush(key, JSON.stringify(value));
      await redis.ltrim(key, 0, max - 1);
    },
    async listRange<T>(key: string, count: number) {
      const raw = await redis.lrange<string>(key, 0, count - 1);
      return raw.map((v) => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T)));
    },
    async zincr(key, member, amount) {
      await redis.zincrby(key, Math.round(amount), member);
    },
    async ztop(key, count) {
      const raw = (await redis.zrange(key, 0, count - 1, {
        rev: true,
        withScores: true,
      })) as (string | number)[];
      const out: ZMember[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        out.push({ member: String(raw[i]), score: Number(raw[i + 1]) });
      }
      return out;
    },
    async incrTtl(key, ttlSec) {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, ttlSec);
      return n;
    },
    async setJSONNX(key, value, ttlSec) {
      const res = await redis.set(key, value, { nx: true, ex: ttlSec });
      return res === "OK";
    },
    async setJSONTtl(key, value, ttlSec) {
      await redis.set(key, value, { ex: ttlSec });
    },
    async del(key) {
      await redis.del(key);
    },
  };
}

function makeMemoryStore(): Store {
  const kv = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const zsets = new Map<string, Map<string, number>>();
  const ttl = new Map<string, { count: number; expireAt: number }>();
  return {
    async getJSON<T>(key: string) {
      return (kv.get(key) as T) ?? null;
    },
    async setJSON(key, value) {
      kv.set(key, value);
    },
    async incrBy(key, amount) {
      const next = ((kv.get(key) as number) ?? 0) + Math.round(amount);
      kv.set(key, next);
      return next;
    },
    async get(key) {
      return (kv.get(key) as number) ?? 0;
    },
    async pushCapped(key, value, max) {
      const arr = lists.get(key) ?? [];
      arr.unshift(value);
      lists.set(key, arr.slice(0, max));
    },
    async listRange<T>(key: string, count: number) {
      return ((lists.get(key) as T[]) ?? []).slice(0, count);
    },
    async zincr(key, member, amount) {
      const z = zsets.get(key) ?? new Map<string, number>();
      z.set(member, (z.get(member) ?? 0) + Math.round(amount));
      zsets.set(key, z);
    },
    async ztop(key, count) {
      const z = zsets.get(key) ?? new Map<string, number>();
      return [...z.entries()]
        .map(([member, score]) => ({ member, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, count);
    },
    async incrTtl(key, ttlSec) {
      const now = Date.now();
      const rec = ttl.get(key);
      if (!rec || rec.expireAt <= now) {
        ttl.set(key, { count: 1, expireAt: now + ttlSec * 1000 });
        return 1;
      }
      rec.count += 1;
      return rec.count;
    },
    // Dev TTL is best-effort (single-process Map); NX semantics are exact so
    // first-writer-wins behaviour (body ownership) is faithfully testable.
    async setJSONNX(key, value) {
      if (kv.has(key)) return false;
      kv.set(key, value);
      return true;
    },
    async setJSONTtl(key, value) {
      kv.set(key, value);
    },
    async del(key) {
      kv.delete(key);
    },
  };
}

// Accept both the native Upstash names and the KV_* names that Vercel's
// Upstash Marketplace integration injects.
function redisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

let _store: Store | null = null;
function store(): Store {
  if (_store) return _store;
  const { url, token } = redisCreds();
  _store = url && token ? makeRedisStore(new Redis({ url, token })) : makeMemoryStore();
  return _store;
}

export function usingSharedStore(): boolean {
  const { url, token } = redisCreds();
  return Boolean(url && token);
}

// ── Keys ─────────────────────────────────────────────────────────────────────
const K_PAGE = (hash: string) => `slip:page:${hash}`;
const K_TOKENS_SAVED = "slip:stat:tokens_saved";
const K_HITS = "slip:stat:hits";
const K_MISSES = "slip:stat:misses";
const K_PAGES = "slip:stat:pages_cached";
const K_ACTIVITY = "slip:activity";
const K_DOMAINS = "slip:domains";
const K_VERSIONS = (h: string) => `slip:ver:${h}`;
const K_NOTES = (key: string) => `slip:notes:${key}`;
const K_NOTES_RECENT = "slip:notes:recent";
const K_NOTES_COUNT = "slip:stat:notes";
const K_NOTE_VOTES = (id: string) => `slip:nv:${id}`;
const K_NOTE_FLAGS = (id: string) => `slip:nf:${id}`;
const K_RL = (action: string, client: string) => `slip:rl:${action}:${client}`;
// Feature 2 — content-address dedup / mirror collapsing.
const K_BODY = (bodyHash: string) => `slip:body:${bodyHash}`;
const K_ALIAS = (hash: string) => `slip:alias:${hash}`;
const K_ALIAS_HITS = "slip:stat:alias_hits";
// Feature 3 — prior section indexes for heading-level temporal diffs.
const K_SECIDX = (uHash: string, cHash: string) => `slip:secidx:${uHash}:${cHash}`;
// Feature 6 — hive "don't-bother" low-yield verdicts.
const K_DONTBOTHER = (hash: string) => `slip:db:${hash}`;
// Tier 1 — demand telemetry (admission control for predictive pre-distillation).
// K_DEMAND_RECENT is the access log WITH urls + timestamps (the 30-item activity
// ring drops the url, so it can't drive a lead-time backtest). K_DEMAND_FREQ is
// the "hot head": how often each doc-set is queried, the gate on speculation.
const K_DEMAND_RECENT = "slip:demand:recent";
const K_DEMAND_FREQ = "slip:demand:freq";
const DEMAND_RECENT_MAX = 2000;

// A note is hidden once enough agents distrust it.
const HIDE_NET = -3;
const HIDE_FLAGS = 5;
const DECAY_HALF_LIFE_DAYS = 30;

// TTLs (seconds) for the new shared indexes.
const ALIAS_TTL_SEC = 24 * 60 * 60; // matches page freshness window
const BODY_TTL_SEC = 25 * 60 * 60; // slightly > page TTL so owner is re-validatable
const PRIOR_IDX_TTL_SEC = 30 * 24 * 60 * 60; // prior bodies expire after 30 days
const DONTBOTHER_TTL_SEC = 6 * 60 * 60; // low-yield verdicts decay so fixed sites recover
const RETAIN_PRIOR = 3; // keep only the last N prior section indexes per URL

export function urlHash(url: string): string {
  let normalized = url.trim();
  try {
    const u = new URL(url);
    u.hash = "";
    // /docs and /docs/ are the same page — don't fragment the shared cache
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    normalized = u.toString();
  } catch {
    /* keep raw string if not a valid URL */
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

// A "doc-set" is the releasable unit we gate predictive prewarm on: domain +
// first path segment, so react.dev/learn and react.dev/reference rank as
// distinct hot sets (closer to how docs map to a package/repo than bare domain).
export function docSetOf(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean)[0];
    return seg ? `${domainOf(url)}/${seg}` : domainOf(url);
  } catch {
    return domainOf(url);
  }
}

export type CachedPage = {
  url: string;
  markdown: string;
  originalTokens: number;
  distilledTokens: number;
  createdAt: number;
  etag?: string;
  lastModified?: string;
  contentHash?: string; // 16-hex display/known_hash fingerprint
  bodyHash?: string; // full 64-hex sha256 of markdown — dedup key (Feature 2)
  index?: SectionIndex; // precomputed section index + per-section hashes (Feature 1)
  ttlMs?: number; // adaptive freshness window from observed volatility (Feature 4)
  renderedWith?: string; // e.g. "firecrawl" when JS-rendered
  spaPartial?: boolean; // SPA detected but no renderer available
};

export async function getCachedPage(hash: string): Promise<CachedPage | null> {
  return store().getJSON<CachedPage>(K_PAGE(hash));
}

export async function putCachedPage(
  hash: string,
  page: CachedPage,
  isNew: boolean,
): Promise<void> {
  const s = store();
  await s.setJSON(K_PAGE(hash), page);
  if (isNew) await s.incrBy(K_PAGES, 1);
}

export type Activity = {
  domain: string;
  saved: number;
  hit: boolean;
  at: number;
};

// Tokens an agent saves on a call = raw fetch cost minus distilled. Recorded on
// every call; also drives the live feed and per-domain leaderboard.
export async function recordSave(
  savedTokens: number,
  hit: boolean,
  url: string,
  alias = false,
): Promise<void> {
  const s = store();
  const domain = domainOf(url);
  const saved = Math.max(0, savedTokens);
  await Promise.all([
    s.incrBy(K_TOKENS_SAVED, saved),
    s.incrBy(hit ? K_HITS : K_MISSES, 1),
    s.zincr(K_DOMAINS, domain, saved),
    s.pushCapped(K_ACTIVITY, { domain, saved, hit, at: Date.now() } as Activity, 30),
    // Tier 1 demand telemetry — once per fetch, retains the url + timestamp.
    s.zincr(K_DEMAND_FREQ, docSetOf(url), 1),
    s.pushCapped(
      K_DEMAND_RECENT,
      { url, domain, at: Date.now() } as DemandEvent,
      DEMAND_RECENT_MAX,
    ),
    ...(alias ? [s.incrBy(K_ALIAS_HITS, 1)] : []),
  ]);
}

// ── Tier 1: demand telemetry readers (for the prewarm backtest + admission gate)
export type DemandEvent = { url: string; domain: string; at: number };

/** Recent fetch events with url + timestamp, newest first (the real access log). */
export async function getRecentDemand(limit = DEMAND_RECENT_MAX): Promise<DemandEvent[]> {
  return store().listRange<DemandEvent>(K_DEMAND_RECENT, limit);
}

/** Hot doc-sets ranked by query frequency — the gate on speculative prewarm. */
export async function getDemandIndex(topN = 100): Promise<ZMember[]> {
  return store().ztop(K_DEMAND_FREQ, topN);
}

// ── Feature 2: content-address dedup / mirror collapsing ──────────────────────
// A body is owned by the first urlHash that crawled it (NX, append-only). Other
// URLs that distill to the SAME body alias to that owner instead of re-crawling.
// The served body is always one the cache already trusted, so a (cryptographically
// infeasible) full-sha256 collision can at worst serve content the agent would
// have fetched anyway.

export type Alias = {
  owner: string; // canonical urlHash that owns the body
  bodyHash: string; // full 64-hex sha256 the alias was minted against
  at: number;
  kind: "same-content" | "mirror";
};

export async function getAlias(hash: string): Promise<Alias | null> {
  return store().getJSON<Alias>(K_ALIAS(hash));
}

export async function putAlias(
  hash: string,
  owner: string,
  bodyHash: string,
  kind: Alias["kind"] = "same-content",
): Promise<void> {
  if (hash === owner) return; // never self-alias
  await store().setJSONTtl(
    K_ALIAS(hash),
    { owner, bodyHash, at: Date.now(), kind } as Alias,
    ALIAS_TTL_SEC,
  );
}

export async function getBodyOwner(bodyHash: string): Promise<string | null> {
  return store().getJSON<string>(K_BODY(bodyHash));
}

/** Claim ownership of a body hash — first writer wins (NX). Returns true if claimed. */
export async function claimBodyOwner(bodyHash: string, owner: string): Promise<boolean> {
  return store().setJSONNX(K_BODY(bodyHash), owner, BODY_TTL_SEC);
}

// ── Feature 3: prior section indexes (heading-level temporal diffs) ────────────
export async function putPriorSectionIndex(
  uHash: string,
  cHash: string,
  index: SectionIndex,
): Promise<void> {
  await store().setJSONTtl(K_SECIDX(uHash, cHash), index, PRIOR_IDX_TTL_SEC);
}

export async function getPriorSectionIndex(
  uHash: string,
  cHash: string,
): Promise<SectionIndex | null> {
  return store().getJSON<SectionIndex>(K_SECIDX(uHash, cHash));
}

export async function delPriorSectionIndex(uHash: string, cHash: string): Promise<void> {
  await store().del(K_SECIDX(uHash, cHash));
}

// ── Feature 6: hive "don't-bother" low-yield verdicts ─────────────────────────
export type LowYield = { reason: string; at: number };

export async function getLowYield(hash: string): Promise<LowYield | null> {
  return store().getJSON<LowYield>(K_DONTBOTHER(hash));
}

export async function putLowYield(hash: string, reason: string): Promise<void> {
  await store().setJSONTtl(
    K_DONTBOTHER(hash),
    { reason, at: Date.now() } as LowYield,
    DONTBOTHER_TTL_SEC,
  );
}

// ── Content version history (substrate for cutoff-aware "what changed") ───────
export type Version = { hash: string; at: number };

export async function addVersion(urlHash: string, hash: string, at: number): Promise<void> {
  await store().pushCapped(K_VERSIONS(urlHash), { hash, at } as Version, 20);
}

// Newest first.
export async function getVersions(urlHash: string): Promise<Version[]> {
  return store().listRange<Version>(K_VERSIONS(urlHash), 20);
}

// ── Collective memory (the hive brain) ───────────────────────────────────────
// Agents leave warnings/corrections/tips on a URL or a free-form topic. Every
// future cached_fetch on that URL surfaces them, and any agent can recall a
// topic directly. This is what turns a cache into a self-improving commons.

export type NoteKind = "gotcha" | "correction" | "tip";
export type Note = {
  id: string;
  target: string; // original URL or topic, for display
  kind: NoteKind;
  text: string;
  votes: number;
  at: number;
  pinHash?: string; // page contentHash when written (Feature 5: self-retiring notes)
  stale?: boolean; // presentation-only: set at read time when the page has changed
};

// Normalize a target to a stable key. URLs collapse to their content-address so
// a note left on a page is found regardless of trivial URL variation.
export function noteKey(target: string): string {
  const t = target.trim();
  if (/^https?:\/\//i.test(t)) return `u:${urlHash(t)}`;
  const slug = t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `t:${slug}`;
}

export type AddNoteResult = { note: Note; deduped: boolean };

export async function addNote(
  target: string,
  text: string,
  kind: NoteKind,
  pinHash?: string,
): Promise<AddNoteResult> {
  const s = store();
  const key = K_NOTES(noteKey(target));

  // Dedup: identical advice already on this target → upvote it instead of
  // adding a near-duplicate. Keeps the hive signal clean.
  const norm = normalizeForDedup(text);
  const existing = await s.listRange<Note>(key, 50);
  const dup = existing.find((n) => normalizeForDedup(n.text) === norm);
  if (dup) {
    await s.incrBy(K_NOTE_VOTES(dup.id), 1);
    return { note: dup, deduped: true };
  }

  const note: Note = {
    id: randomUUID().slice(0, 8),
    target,
    kind,
    text: text.slice(0, 500),
    votes: 1,
    at: Date.now(),
    ...(pinHash ? { pinHash } : {}),
  };
  await Promise.all([
    s.pushCapped(key, note, 50),
    s.pushCapped(K_NOTES_RECENT, note, 30),
    s.incrBy(K_NOTES_COUNT, 1),
    s.incrBy(K_NOTE_VOTES(note.id), 1),
  ]);
  return { note, deduped: false };
}

// Attach live vote/flag counts, drop distrusted notes, and rank by a
// decay-weighted net score so trustworthy + recent advice rises.
async function rankNotes(notes: Note[]): Promise<Note[]> {
  const s = store();
  const now = Date.now();
  const scored = await Promise.all(
    notes.map(async (n) => {
      const [votes, flags] = await Promise.all([
        s.get(K_NOTE_VOTES(n.id)),
        s.get(K_NOTE_FLAGS(n.id)),
      ]);
      return { n: { ...n, votes }, flags, net: votes - flags };
    }),
  );
  return scored
    .filter((x) => x.net > HIDE_NET && x.flags < HIDE_FLAGS)
    .map((x) => {
      const ageDays = (now - x.n.at) / 86_400_000;
      const weight = x.net * Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
      return { ...x, weight };
    })
    .sort((a, b) => b.weight - a.weight || b.n.at - a.n.at)
    .map((x) => x.n);
}

export async function getNotes(target: string, limit = 8): Promise<Note[]> {
  const raw = await store().listRange<Note>(K_NOTES(noteKey(target)), 50);
  return (await rankNotes(raw)).slice(0, limit);
}

// Soft-label (never hide) notes written against an older version of the page.
// A pinned note whose contentHash no longer matches the live page is flagged
// "may be stale — page changed since written" so agents weight it accordingly.
export function markStaleNotes(notes: Note[], currentContentHash?: string): Note[] {
  if (!currentContentHash) return notes;
  return notes.map((n) =>
    n.pinHash && n.pinHash !== currentContentHash ? { ...n, stale: true } : n,
  );
}

export async function voteNote(id: string): Promise<number> {
  return store().incrBy(K_NOTE_VOTES(id), 1);
}

export async function flagNote(id: string): Promise<number> {
  return store().incrBy(K_NOTE_FLAGS(id), 1);
}

export async function getRecentNotes(limit = 10): Promise<Note[]> {
  const raw = await store().listRange<Note>(K_NOTES_RECENT, 30);
  return (await rankNotes(raw)).slice(0, limit);
}

// Trusted, visible notes on a target created after a cutoff timestamp.
export async function getNotesSince(
  target: string,
  sinceMs: number,
  limit = 20,
): Promise<Note[]> {
  const all = await getNotes(target, 50);
  return all.filter((n) => n.at > sinceMs).slice(0, limit);
}

// Sliding-window rate limit shared across all serverless invocations.
export async function rateLimit(
  clientId: string,
  action: string,
  limit: number,
  windowSec: number,
): Promise<{ allowed: boolean; count: number; limit: number }> {
  const count = await store().incrTtl(K_RL(action, clientId), windowSec);
  return { allowed: count <= limit, count, limit };
}

// Pricing + tangibility for the public counter. Stated assumptions, not magic.
const USD_PER_MILLION_TOKENS = 3; // blended ~$3 / 1M tokens
const WORDS_PER_TOKEN = 0.75;
const WORDS_PER_BOOK = 90_000; // ~a 300-page novel

export type Stats = {
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
  aliasHits: number;
};

export async function getStats(): Promise<Stats> {
  const s = store();
  const [tokensSaved, hits, misses, pagesCached, topDomains, activity, notesCount, aliasHits] =
    await Promise.all([
      s.get(K_TOKENS_SAVED),
      s.get(K_HITS),
      s.get(K_MISSES),
      s.get(K_PAGES),
      s.ztop(K_DOMAINS, 8),
      s.listRange<Activity>(K_ACTIVITY, 12),
      s.get(K_NOTES_COUNT),
      s.get(K_ALIAS_HITS),
    ]);
  const recentNotes = await getRecentNotes(8);
  const total = hits + misses;
  return {
    tokensSaved,
    hits,
    misses,
    pagesCached,
    hitRate: total ? hits / total : 0,
    shared: usingSharedStore(),
    usdSaved: (tokensSaved / 1_000_000) * USD_PER_MILLION_TOKENS,
    booksOfText: (tokensSaved * WORDS_PER_TOKEN) / WORDS_PER_BOOK,
    topDomains,
    activity,
    notesCount,
    recentNotes,
    aliasHits,
  };
}
