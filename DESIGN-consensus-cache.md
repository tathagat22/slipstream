# Design: the Cross-Agent Consensus Answer Cache (Tier 2)

> Status: proposal / research bet. The one genuinely novel direction from the
> discovery engine — it missed surviving the skeptic panel by a single vote.
> This doc exists to beat the specific objection that nearly killed it.

## The idea in one line
Cache the **verified claim** (a fact + its citation), not the document — keyed by
the *question*, so the large fraction of repeated, answer-shaped fetches settle
against a netted knowledge book instead of re-distilling a page.

## Why it almost died (the objection we must beat)
Two skeptic objections, both fair:

1. **Verification cost re-enters.** "A claim still has to be verified per source,
   which re-introduces exactly the cost you removed." If extracting + trusting a
   claim needs its own LLM pass per page, you've just moved the work.
2. **It breaks the cryptographic safety floor.** Slipstream's dedup only aliases
   on `sha256(body) === sha256(owner)` — serving wrong content is *impossible*.
   A semantic/answer match replaces that categorical floor with a tuned
   similarity threshold that can serve content the agent never asked for.

A design that ignores these is dead on arrival. This one is built around them.

## The two moves that beat the objection

### Move 1 — claims are a *byproduct of the distill you already run*, not a new pass
On a cache **miss**, Slipstream already parses the DOM and emits section-scoped
markdown with per-section sha256 (`buildSectionIndex` in `lib/secdiff.ts`). Claim
extraction rides that **same** pass: for each section, extract `(subject,
predicate, value)` triples (cheap structured extraction — a small model or even
heuristics on the already-clean markdown, run once, amortized over every future
agent). No new fetch, no per-read verification. The write cost is paid once by
the first agent, exactly like the existing distillation.

### Move 2 — restore a safety floor with CONSENSUS, not a threshold
A claim is only **servable** as a netted answer when **≥ N independent
distillations attest the same value at the same section content-hash**. The
floor is no longer "cosine > 0.9" (continuous, gameable) — it is "K independent
agents, distilling K independent fetches, derived the identical pinned claim"
(discrete, and *un-fakeable without controlling K independent agents* — which is
the same moat as the hive brain's sybil resistance). Below N, the claim is
*candidate-only* and the read falls back to serving the document. The citation
(`url` + `section-hash`) is always returned, so the answer is auditable, never a
bare assertion.

## Data model (Redis, fits the existing store)
```
slip:claim:<claimHash>      → { subject, predicate, value,
                                citations: [{urlHash, sectionHash, at}],   // distinct sources
                                attest: <count of independent distillations agreeing>,
                                firstAt, lastConfirmedAt }
slip:qindex                 → ANN/embedding index: questionEmbedding → claimHash
                              (Upstash Vector, or a coarse LSH bucket in Redis to start)
slip:claim:bysection:<secHash> → set(claimHash)   // reverse index for invalidation
```
- `claimHash = sha256(normalize(subject|predicate))` — the netting key; the same
  fact from different pages collapses here (this is the "clearing-house netting").
- Freshness is **free**: claims are pinned to `sectionHash`. The Living Web
  Changelog already detects when a section's hash changes — that signal walks
  `slip:claim:bysection:<oldSecHash>` and marks those claims `stale` (drop
  attestation, require re-confirmation). No polling; reuse `secdiff`.

## Flow
**Write (on miss, in the existing distill path):**
1. distill → `buildSectionIndex` (already happens).
2. for each section: extract claims → for each, upsert `slip:claim:<claimHash>`,
   append the `(urlHash, sectionHash)` citation **iff it's a new independent
   source**, `attest = count(distinct citations)`.
3. index the claim's canonical question embedding into `slip:qindex`.

**Read (new fast path, before the document path):**
1. embed the agent's question; ANN-lookup nearest claim(s).
2. gate: similarity ≥ τ **AND** `attest ≥ N` **AND** not `stale`.
3. pass → return the netted value + **all citations** (token cost ≈ the claim,
   ~0 vs a full page). fail → today's `cached_fetch` document path, unchanged.

## Why only Slipstream can build it
Attestation volume is the input. A single-session fetcher sees one distillation
of one page; it can never know that 12 independent agents derived the same fact.
The consensus floor is *structurally* a property of the shared cross-agent layer.

## Failure modes → mitigations
| Risk | Mitigation |
|---|---|
| Hallucinated/garbage claims | Consensus gate (N independent distillations) + mandatory citation + extraction confined to clean distilled markdown, not raw HTML. |
| Poisoning (sybil agents inflate `attest`) | Attestation counts **distinct fetched sources / distillations**, not votes; reuse the hive-brain trust + the existing rate-limit/clientId defenses. Cold claims never serve. |
| Embedding false-positive (wrong question → confident wrong answer) | Two-key gate: semantic match **and** the returned citation's `sectionHash` must still be live. Conservative τ; on doubt, serve the document. |
| Staleness (fact changed) | `sectionHash` pinning + Living-Web-Changelog invalidation walks the reverse index. A changed section drops its claims to candidate-only. |
| Answer-shaped vs document-shaped queries | Only the answer-shaped fraction uses this path; everything else is unchanged. Pure upside, bounded downside. |

## Smallest experiment (offline, < 1 week, no new infra)
Run claim extraction over the pages **already in the cache** and measure the one
number the whole bet rests on: **consensus rate** — across distinct cached
URLs/sources, how often do independent pages yield the *same* `(subject,
predicate, value)` claim? 
- High consensus rate (e.g. common API facts, version numbers, rate limits
  recur across mirrors/tutorials/docs) → the netting has real mass → build the
  read path.
- Low consensus rate (every fact is singly-sourced) → `attest ≥ N` almost never
  trips → the safety floor blocks everything → **kill it**, the answer-cache has
  no netting to exploit.

Also measure the answer-shaped query fraction from `slip:demand:recent` once it
accrues — that bounds the addressable upside.

## Honest assessment
This is a research bet, not a sure thing: extraction quality and the cold-start
of the consensus threshold are real unknowns, and the offline consensus-rate
experiment is the gate that decides whether it's worth building at all. But it is
the only direction that is *both* genuinely novel *and* defensible only by the
shared layer — and it changes the unit of caching from document → fact, which is
the deepest lever in the whole decomposition.
