import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";

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
  };
}

function makeMemoryStore(): Store {
  const kv = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const zsets = new Map<string, Map<string, number>>();
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
  };
}

let _store: Store | null = null;
function store(): Store {
  if (_store) return _store;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _store = url && token ? makeRedisStore(new Redis({ url, token })) : makeMemoryStore();
  return _store;
}

export function usingSharedStore(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

// ── Keys ─────────────────────────────────────────────────────────────────────
const K_PAGE = (hash: string) => `slip:page:${hash}`;
const K_TOKENS_SAVED = "slip:stat:tokens_saved";
const K_HITS = "slip:stat:hits";
const K_MISSES = "slip:stat:misses";
const K_PAGES = "slip:stat:pages_cached";
const K_ACTIVITY = "slip:activity";
const K_DOMAINS = "slip:domains";

export function urlHash(url: string): string {
  let normalized = url.trim();
  try {
    const u = new URL(url);
    u.hash = "";
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

export type CachedPage = {
  url: string;
  markdown: string;
  originalTokens: number;
  distilledTokens: number;
  createdAt: number;
  etag?: string;
  lastModified?: string;
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
): Promise<void> {
  const s = store();
  const domain = domainOf(url);
  const saved = Math.max(0, savedTokens);
  await Promise.all([
    s.incrBy(K_TOKENS_SAVED, saved),
    s.incrBy(hit ? K_HITS : K_MISSES, 1),
    s.zincr(K_DOMAINS, domain, saved),
    s.pushCapped(K_ACTIVITY, { domain, saved, hit, at: Date.now() } as Activity, 30),
  ]);
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
};

export async function getStats(): Promise<Stats> {
  const s = store();
  const [tokensSaved, hits, misses, pagesCached, topDomains, activity] =
    await Promise.all([
      s.get(K_TOKENS_SAVED),
      s.get(K_HITS),
      s.get(K_MISSES),
      s.get(K_PAGES),
      s.ztop(K_DOMAINS, 8),
      s.listRange<Activity>(K_ACTIVITY, 12),
    ]);
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
  };
}
