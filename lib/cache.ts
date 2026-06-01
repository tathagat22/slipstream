import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";

// ── Storage backend ─────────────────────────────────────────────────────────
// Production: Upstash Redis (shared across every serverless invocation = a real
// cross-agent cache). Local/dev with no env: an in-process Map so it just runs.
// The Map does NOT persist or share across processes — that's expected; the
// whole point of the hosted version is the shared Redis corpus.

type Store = {
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
  incrBy(key: string, amount: number): Promise<number>;
  get(key: string): Promise<number>;
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
  };
}

function makeMemoryStore(): Store {
  const kv = new Map<string, unknown>();
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

export function urlHash(url: string): string {
  // Normalize so trivial variations share a cache entry.
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

export type CachedPage = {
  url: string;
  markdown: string;
  originalTokens: number;
  distilledTokens: number;
  createdAt: number;
};

export async function getCachedPage(hash: string): Promise<CachedPage | null> {
  return store().getJSON<CachedPage>(K_PAGE(hash));
}

export async function putCachedPage(hash: string, page: CachedPage): Promise<void> {
  const s = store();
  await s.setJSON(K_PAGE(hash), page);
  await s.incrBy(K_PAGES, 1);
}

// Tokens an agent saves on a call = what raw fetch would have cost (original)
// minus what we returned (distilled). True on both hits and misses.
export async function recordSave(savedTokens: number, hit: boolean): Promise<void> {
  const s = store();
  await Promise.all([
    s.incrBy(K_TOKENS_SAVED, Math.max(0, savedTokens)),
    s.incrBy(hit ? K_HITS : K_MISSES, 1),
  ]);
}

export type Stats = {
  tokensSaved: number;
  hits: number;
  misses: number;
  pagesCached: number;
  hitRate: number;
  shared: boolean;
};

export async function getStats(): Promise<Stats> {
  const s = store();
  const [tokensSaved, hits, misses, pagesCached] = await Promise.all([
    s.get(K_TOKENS_SAVED),
    s.get(K_HITS),
    s.get(K_MISSES),
    s.get(K_PAGES),
  ]);
  const total = hits + misses;
  return {
    tokensSaved,
    hits,
    misses,
    pagesCached,
    hitRate: total ? hits / total : 0,
    shared: usingSharedStore(),
  };
}
