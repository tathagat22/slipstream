import { lookup } from "node:dns/promises";

// ── SSRF protection ───────────────────────────────────────────────────────────
// Slipstream fetches URLs supplied by untrusted agents. Without these guards an
// agent could make our server hit cloud metadata endpoints, localhost admin
// panels, or private network hosts. We validate the scheme, then resolve the
// host and reject any address in a private/reserved range — at every redirect
// hop.

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

function ipv4ToLong(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(base) & mask);
}

function isPrivateV4(ip: string): boolean {
  return (
    inV4Range(ip, "0.0.0.0", 8) || // "this" network
    inV4Range(ip, "10.0.0.0", 8) || // private
    inV4Range(ip, "100.64.0.0", 10) || // CGNAT
    inV4Range(ip, "127.0.0.0", 8) || // loopback
    inV4Range(ip, "169.254.0.0", 16) || // link-local (incl. cloud metadata)
    inV4Range(ip, "172.16.0.0", 12) || // private
    inV4Range(ip, "192.0.0.0", 24) || // IETF protocol
    inV4Range(ip, "192.168.0.0", 16) || // private
    inV4Range(ip, "198.18.0.0", 15) || // benchmarking
    inV4Range(ip, "224.0.0.0", 4) || // multicast
    inV4Range(ip, "240.0.0.0", 4) // reserved
  );
}

function isPrivateV6(ip: string): boolean {
  const a = ip.toLowerCase();
  if (a === "::1" || a === "::") return true;
  if (a.startsWith("::ffff:")) {
    const tail = a.slice(7);
    if (tail.includes(".")) return isPrivateV4(tail);
  }
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // unique-local fc00::/7
  if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb"))
    return true; // link-local fe80::/10
  return false;
}

function isPrivateAddress(ip: string): boolean {
  return ip.includes(":") ? isPrivateV6(ip) : isPrivateV4(ip);
}

export async function assertSafeUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SecurityError("Invalid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SecurityError(`Unsupported scheme '${u.protocol}'. Only http/https.`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (/^localhost$/i.test(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new SecurityError("Refusing to fetch internal/loopback host.");
  }
  // Resolve and reject any private/reserved address. (Residual DNS-rebinding
  // risk is small given per-hop checks; acceptable for v1.)
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SecurityError(`Could not resolve host '${host}'.`);
  }
  if (!addrs.length) throw new SecurityError(`Host '${host}' did not resolve.`);
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new SecurityError("Refusing to fetch a private/reserved network address.");
    }
  }
}

// ── Safe fetch ────────────────────────────────────────────────────────────────
// Manual redirects (each hop re-validated), wall-clock timeout, and a hard byte
// cap so a hostile or huge page can't exhaust the function.

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

export type SafeResponse = {
  status: number;
  finalUrl: string;
  headers: Headers;
  body: Response["body"];
  raw: Response;
};

export async function safeFetch(
  url: string,
  headers: Record<string, string>,
): Promise<SafeResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, { headers, redirect: "manual", signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new SecurityError(`Upstream timed out after ${TIMEOUT_MS}ms.`);
      }
      throw err;
    }
    clearTimeout(timer);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new SecurityError("Redirect without a Location header.");
      current = new URL(loc, current).toString();
      continue;
    }
    return { status: res.status, finalUrl: current, headers: res.headers, body: res.body, raw: res };
  }
  throw new SecurityError("Too many redirects.");
}

export function assertHtmlLike(contentType: string | null): void {
  if (!contentType) return; // some servers omit it; allow
  const ct = contentType.toLowerCase();
  const ok =
    ct.includes("text/html") ||
    ct.includes("application/xhtml") ||
    ct.includes("text/plain") ||
    ct.includes("application/xml") ||
    ct.includes("text/xml");
  if (!ok) {
    throw new SecurityError(`Unsupported content-type '${contentType}'. Slipstream distills HTML/text.`);
  }
}

/** Read a response body as text with a hard byte cap (streaming). */
export async function readCapped(res: SafeResponse): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared && declared > MAX_BYTES) {
    throw new SecurityError(`Page too large (${declared} bytes > ${MAX_BYTES}).`);
  }
  if (!res.body) return await res.raw.text();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new SecurityError(`Page exceeded ${MAX_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// ── Note sanitization (anti prompt-injection) ─────────────────────────────────
// Collective notes are agent-submitted untrusted text that we inject into other
// agents' context. We force them to a single safe line, strip code fences and
// role/command markers that could be read as instructions, and flag suspicious
// content. The renderer also wraps them with an explicit untrusted label.

const INJECTION_MARKERS =
  /\b(ignore (all|the|previous|above)|disregard (all|the|previous)|system prompt|you are now|new instructions?|act as|jailbreak|developer mode|override (your|the) (instructions|rules))\b/i;

export type Sanitized = { clean: string; suspicious: boolean };

export function sanitizeNoteText(input: string): Sanitized {
  let t = input.normalize("NFC");
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\x00-\x1F\x7F]/g, " "); // strip control chars
  t = t.replace(/`{1,}/g, "'"); // defang code fences/backticks
  t = t.replace(/[<>]/g, ""); // no raw angle brackets / pseudo-tags
  t = t.replace(/\s+/g, " ").trim();
  const suspicious = INJECTION_MARKERS.test(t);
  return { clean: t.slice(0, 500), suspicious };
}

/** Normalized form for dedup: lowercase, alphanumeric-only. */
export function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
