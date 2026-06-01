import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? "https://slipstream-pi.vercel.app/api/mcp";
const URL_T = "https://en.wikipedia.org/wiki/Model_Context_Protocol";

const transport = new StreamableHTTPClientTransport(new URL(base));
const client = new Client({ name: "verify", version: "1.0.0" });
await client.connect(transport);
const txt = (r) => r.content[0].text;

console.log("TOOLS:", (await client.listTools()).tools.map((t) => t.name).join(", "));

// 1. cached_fetch → capture contentHash from the footer
const f = await client.callTool({ name: "cached_fetch", arguments: { url: URL_T, token_budget: 300 } });
const hash = /contentHash ([0-9a-f]+)/.exec(txt(f))?.[1];
console.log("\n1) cached_fetch → contentHash:", hash, "| tail:", txt(f).slice(-90));

// 2. delta: re-fetch with known_hash → should be UNCHANGED, ~0 returned tokens
const d = await client.callTool({ name: "cached_fetch", arguments: { url: URL_T, known_hash: hash } });
console.log("\n2) delta (known_hash):", txt(d).slice(0, 140));

// 3. outline
const o = await client.callTool({ name: "cached_outline", arguments: { url: URL_T } });
console.log("\n3) outline (first 6 lines):\n" + txt(o).split("\n").slice(0, 6).join("\n"));

// 4. section fetch
const sec = await client.callTool({ name: "cached_fetch", arguments: { url: URL_T, section: "History", token_budget: 200 } });
console.log("\n4) section 'History' (first 120 chars):", txt(sec).slice(0, 120).replace(/\n/g, " "));

// 5. collective memory: note → recall → vote
const note = await client.callTool({
  name: "slipstream_note",
  arguments: { target: "npm:next", text: "next build needs Node >=18.18; older Node fails with cryptic SWC errors.", kind: "gotcha" },
});
console.log("\n5a) note:", txt(note));
const noteId = /Saved note (\w+)/.exec(txt(note))?.[1];
const rec = await client.callTool({ name: "slipstream_recall", arguments: { target: "npm:next" } });
console.log("5b) recall:", txt(rec).replace(/\n/g, " "));
if (noteId) {
  const v = await client.callTool({ name: "slipstream_vote", arguments: { note_id: noteId } });
  console.log("5c) vote:", txt(v));
}

// 6. stats
console.log("\n6) STATS:\n" + txt(await client.callTool({ name: "slipstream_stats", arguments: {} })));
await client.close();
