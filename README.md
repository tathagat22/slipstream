# Slipstream

**A shared distillation cache for AI agents. Every agent makes the web cheaper for the next.**

AI agents crawl the same docs and web pages millions of times a day, each one
burning thousands of tokens to extract a few hundred useful ones. Slipstream is a
**hosted MCP server** that clean-crawls a URL once, distills it to token-optimal
markdown, and serves that distillation — **content-addressed and shared across
every agent on Earth**. The first agent to hit a URL pays the crawl. Every agent
after drafts in its slipstream.

A live public counter shows **tokens saved for agents worldwide** — the network
effect made visible.

## Measured savings (server-rendered pages)

| Page | Raw tokens | Distilled | Saved |
|------|-----------:|----------:|------:|
| Wikipedia article | 44,183 | 5,055 | **88.6%** |
| Wikipedia article | 41,441 | 11,206 | **73%** |

Savings are denominated in tokens — i.e. in dollars — which is also the pricing
lever.

## How it works

1. Your agent calls `cached_fetch(url)` instead of a raw web fetch.
2. **Miss** → Slipstream crawls, strips boilerplate (Readability), converts to
   markdown, and stores it content-addressed for everyone.
3. **Hit** → every agent after gets the distillation instantly, for a fraction of
   the tokens.

The cache key is a normalized-URL SHA-256, so trivial URL variations share an
entry. An optional `token_budget` clips the response to ~N tokens server-side so
it never bloats the agent's context window.

## MCP tools

- `cached_fetch(url, token_budget?)` — distilled markdown from the shared cache.
- `slipstream_stats()` — global tokens-saved / hit-rate / pages-cached.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000  (landing page + live counter)
```

The MCP endpoint is at `http://localhost:3000/api/mcp`. With no env set,
Slipstream runs fully in-memory — great for dev, but the cache is per-process and
not shared. For a **real shared cache**, add Upstash Redis (see below).

## Connect an agent

Add to your MCP client config (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "slipstream": { "url": "https://YOUR-DEPLOYMENT.vercel.app/api/mcp" }
  }
}
```

## Deploy (Vercel)

1. Push this repo and import it on Vercel.
2. Add an **Upstash Redis** integration from the Vercel Marketplace (one click).
   It sets `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` automatically.
3. Deploy. The cache and global counter are now shared across every invocation
   and every agent.

## Known limitations / roadmap

- **JS-rendered SPAs**: static HTML has no readable body, so distilled content can
  be incomplete (savings look huge but content is thin). Upgrade path: a headless
  render (Firecrawl / Playwright) for SPA URLs.
- **Cache freshness**: entries don't yet expire — add a TTL + revalidation.
- **Delta serving**: return only what changed since the version an agent already
  knows (planned).
- **Trust / poisoning**: shared content is an attack surface — add provenance and
  content signing before opening the corpus widely.

## License

MIT
