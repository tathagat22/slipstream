import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? "https://slipstream-pi.vercel.app/api/mcp";
const c = new Client({ name: "fc", version: "1.0.0" });
await c.connect(new StreamableHTTPClientTransport(new URL(base)));
const call = (n, a) => c.callTool({ name: n, arguments: a });
const txt = (r) => r.content[0].text;
let pass = 0, fail = 0;
const check = (n, cond, d = "") => { console.log(`${cond ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); cond ? pass++ : fail++; };

const topic = `fc-${process.pid}-${Date.now()}`;

// Seed a correction (timestamped now).
await call("slipstream_note", {
  target: topic,
  text: "As of v3 the default export was removed; import the named createClient instead.",
  kind: "correction",
});

// whats_new since a past date → should surface the correction.
const past = await call("whats_new", { target: topic, since: "2024-01-01" });
check("whats_new returns post-cutoff correction", /createClient/.test(txt(past)), txt(past).slice(0, 90));

// whats_new since a FUTURE date → nothing should be newer.
const future = await call("whats_new", { target: topic, since: "2099-01-01" });
check("whats_new respects future cutoff (nothing newer)", /nothing recorded as changed/i.test(txt(future)), txt(future).slice(0, 80));

// Model id resolves to a cutoff (no explicit since).
const byModel = await call("whats_new", { target: topic, model: "claude-opus-4-8" });
check("model id resolves to cutoff", /since claude-opus-4-8/i.test(txt(byModel)) || /nothing recorded/i.test(txt(byModel)), txt(byModel).slice(0, 90));

// Unknown model + no since → helpful error.
const bad = await call("whats_new", { target: topic, model: "totally-unknown-model-xyz" });
check("unknown model errors helpfully", bad.isError === true && /known 'model'|since/i.test(txt(bad)), txt(bad).slice(0, 80));

console.log(`\n${pass} passed, ${fail} failed`);
await c.close();
process.exit(fail ? 1 : 0);
