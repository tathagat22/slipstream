# Slipstream — "Living Web Changelog" Roadmap

> Produced by a 16-agent design swarm (6 ideators → 3 adversarial judges → architect → per-feature specs).
> 28 raw ideas generated, ruthlessly culled to 6 buildable, secure, genuinely-novel features.

## 🚩 Flagship: Heading-level temporal diffs across agents

**The first agent to re-crawl a changed page computes the per-section delta once, and every later
agent that cites an old `contentHash` inherits "only these 3 of 18 sections changed" for ~0 tokens —
a shared, content-addressed changelog of the live web that no stateless fetcher can build.**

A single-agent fetcher (Firecrawl, Jina Reader, raw WebFetch) sees one snapshot per session and
*structurally cannot* answer "what changed since the version you cited." Slipstream can, because the
cache is shared and content-addressed across every agent and every session. That is the moat.

---

## The 6 selected features (build order)

| # | Feature | Effort | Saves | Depends on |
|---|---------|--------|-------|------------|
| 1 | **Precomputed section index + per-section hashes** (substrate) | S | Near-free outline/section reads; unlocks the flagship | none |
| 2 | **Content-address dedup + mirror collapsing** | M | Full document tokens per alias hit; lifts hit rate to double digits | none |
| 3 | **Semantic diff layer** (return only changed sections) | M | 80–90% on every revisit of a living doc | #1 |
| 4 | **Adaptive volatility-driven TTL** (kill the flat 24h) | S | Avoids cold re-crawls of stable pages; keeps deltas valid longer | none |
| 5 | **Temporal note expiry** (version-pin notes) | S | Stops stale gotchas causing wasted retry loops | #1 |
| 6 | **Hive "don't-bother" index** (SPA-traps / paywalls / dead-ends) | S | ~1–2k tokens per avoided dead-end crawl | none |

### Why these and not the obvious ones
The swarm **rejected** (with reasons): cached reasoning artifacts & answer-caching (unfixably
poisonable — a hostile page legitimately *contains* wrong facts; consensus is defeated because
`clientId` is a spoofable `x-forwarded-for`), cross-URL LLM synthesis (no LLM on this stack +
laundering attack), server-push subscriptions (contradict stateless Vercel + timing oracle),
predictive prefetch (reflective-DDoS/cost amplifier on an unauthenticated endpoint),
popularity-driven TTL (promotion keys on spoofable client id → pin a poisoned URL for 30d), and
MCP-prompt note auto-injection (maximum-blast-radius prompt-injection position).

---

## Sequencing rationale

1. **Section index first** — pure-CPU internal refactor, lowest risk, and the load-bearing dependency
   for the flagship diff (#3) and note-pinning (#5). Must land first.
2. **Content-address dedup** — independent; attacks the documented killer finding head-on
   (`pagesCached == misses == 258`, ~0 repeat traffic) with the largest per-hit magnitude. Ship next
   to immediately lift the hit rate.
3. **Semantic diff layer** — the flagship; sits directly on #1's section hashes.
4. **Volatility TTL** — independent and small; pairs with #3 (stable pages stay warm → more
   revalidations resolve as cheap section-deltas instead of cold re-crawls).
5. **Temporal note expiry** — reuses #1's section hashes to keep collective memory self-correcting.
6. **Don't-bother index** — fully independent, trivially safe (objective machine signals only).

Every step is shippable alone, each early step unlocks a later one, and **risk rises monotonically so
the build stays green at every commit.**

---

## Security posture (this is a public, unauthenticated, multi-tenant endpoint)

- **No new fetch path** in #1, #5, #6 → SSRF posture unchanged.
- **Dedup (#2)** keys aliases on the **full 64-hex sha256** (not the 16-char display hash); body
  ownership is **NX / append-only** (a cross-origin crawl can never overwrite a trusted body);
  cross-origin mirror maps are a **hardcoded vetted allowlist, never learned from traffic**.
- **Volatility (#4)** derives only from internal content hashes — no spoofable client input; hard-caps
  TTL at 7d and always honors origin ETag/Last-Modified revalidation above a volatility threshold.
- **Notes (#5)** only ever **soft-label** as stale (never hard-hide), gated to the same heading-section.
- **Don't-bother (#6)** v1 verdicts derive only from objective signals the cache measured itself
  (`spaPartial` / byte count / HTTP status); agent-suggested alternative URLs are deferred.

See the individual feature commits for the full per-feature threat model and verification plan.
