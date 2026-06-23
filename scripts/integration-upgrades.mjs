// End-to-end test of the new features against a RUNNING server (in-memory store).
// Usage: node scripts/integration-upgrades.mjs [baseUrl]
// SAFETY: refuses to run unless the server reports the in-memory dev store, so it
// can never pollute the production shared cache.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? "http://localhost:3000/api/mcp";
const URL_T = "https://en.wikipedia.org/wiki/Model_Context_Protocol";

const transport = new StreamableHTTPClientTransport(new URL(base));
const client = new Client({ name: "integration-upgrades", version: "1.0.0" });
await client.connect(transport);
const txt = (r) => r.content[0].text;
const call = (name, args) => client.callTool({ name, arguments: args });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${detail}`);
  }
};

// SAFETY GATE — must be the in-memory dev store.
const stats0 = txt(await call("slipstream_stats", {}));
if (!/in-memory dev/.test(stats0)) {
  console.error("\n❌ ABORT: server is using the SHARED (Redis) store — refusing to run to avoid polluting production. Start dev with empty KV_/UPSTASH_ env vars.\n");
  process.exit(2);
}
console.log("Safety gate OK — in-memory dev store.\n");

console.log("— Feature 1: precomputed outline + section read —");
const f = await call("cached_fetch", { url: URL_T, token_budget: 400 });
const hash = /contentHash ([0-9a-f]+)/.exec(txt(f))?.[1];
ok("first fetch is a cache MISS", /cache MISS/.test(txt(f)), txt(f).slice(-100));
ok("footer exposes a contentHash", !!hash);

const o = await call("cached_outline", { url: URL_T });
ok("outline returns headings", /\(~\d+ tok\)/.test(txt(o)));

const sec = await call("cached_fetch", { url: URL_T, section: "History", token_budget: 300 });
ok("section fetch returns content", txt(sec).length > 50 && !/no headings/.test(txt(sec)));

console.log("\n— Feature 2: same-origin collapse (canonicalization → cache HIT) —");
const utm = await call("cached_fetch", { url: `${URL_T}?utm_source=test&gclid=abc`, token_budget: 400 });
ok("tracking-param variant collapses to a cache HIT", /cache HIT/.test(txt(utm)), txt(utm).slice(-100));

console.log("\n— Regression: exact known_hash delta short-circuit —");
const d = await call("cached_fetch", { url: URL_T, known_hash: hash });
ok("exact known_hash → UNCHANGED (~0 tokens)", /UNCHANGED/.test(txt(d)));

console.log("\n— Regression: note (URL target, Feature 5 pin path) → recall —");
const note = await call("slipstream_note", {
  target: URL_T,
  text: "MCP spec revision 2025-06-18 deprecated the old SSE transport; use Streamable HTTP.",
  kind: "correction",
});
ok("note saved on a URL target", /Saved note|already existed/.test(txt(note)));
const rec = await call("slipstream_recall", { target: URL_T });
ok("note recalled", /SSE transport|Streamable HTTP/.test(txt(rec)));

console.log("\n— Feature 2 wiring: stats exposes alias-hit counter —");
const stats = txt(await call("slipstream_stats", {}));
ok("stats renders the dedup/mirror alias line", /alias hits/i.test(stats));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed\n`);
await client.close().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
