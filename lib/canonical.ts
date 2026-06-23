// ── Feature 2: URL canonicalization + vetted mirror allowlist ─────────────────
// Pure, no network, no learning. Collapses trivial same-origin URL variation
// (www, tracking params, trailing slash) so byte-identical pages share one cache
// entry, and resolves a SMALL hardcoded set of faithful cross-origin mirrors.
// Cross-origin mirror rules are NEVER learned from traffic — an attacker cannot
// register their host as a "mirror" of a popular domain.

export type Canonical = {
  canonicalUrl: string; // stable string used to derive the cache key
  fetchUrl: string; // the URL we actually crawl (differs only for vetted mirrors)
  kind: "raw" | "normalized" | "mirror";
};

// Query params that are pure tracking noise — safe to strip without changing
// the page a server returns. Deliberately conservative (no generic `ref`).
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "_ga",
  "yclid",
  "msclkid",
  "ref_src",
]);

// Vetted, faithful cross-origin mirrors only. Each rule maps a host to a
// canonical host that serves equivalent HTML. Same-content verification still
// runs on first crawl, so a wrong rule fails safe (no alias) rather than serving
// wrong content.
const MIRROR_RULES: { match: RegExp; rewrite: (u: URL) => URL | null }[] = [
  {
    // ar5iv.labs.arxiv.org is the lab host for the same HTML rendering as ar5iv.org
    match: /^ar5iv\.labs\.arxiv\.org$/i,
    rewrite: (u) => {
      const next = new URL(u.toString());
      next.hostname = "ar5iv.org";
      return next;
    },
  },
];

function stripTracking(u: URL): void {
  const keys = [...u.searchParams.keys()];
  for (const k of keys) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
  }
}

/**
 * Normalize a URL for cache-keying and resolve any vetted mirror. Never emits a
 * non-http(s) scheme or an internal host — the result is still passed through
 * safeFetch, which re-validates every hop against SSRF.
 */
export function canonicalize(rawUrl: string): Canonical {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { canonicalUrl: rawUrl, fetchUrl: rawUrl, kind: "raw" };
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { canonicalUrl: rawUrl, fetchUrl: rawUrl, kind: "raw" };
  }

  // Same-origin normalization.
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  stripTracking(u);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  // Drop a now-empty "?".
  let normalized = u.toString();

  // Vetted mirror resolution.
  for (const rule of MIRROR_RULES) {
    if (rule.match.test(u.hostname)) {
      const rewritten = rule.rewrite(u);
      if (rewritten) {
        const fetchUrl = rewritten.toString();
        return { canonicalUrl: fetchUrl, fetchUrl, kind: "mirror" };
      }
    }
  }

  return {
    canonicalUrl: normalized,
    fetchUrl: normalized,
    kind: normalized === rawUrl ? "raw" : "normalized",
  };
}
