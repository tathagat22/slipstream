// Cache-layer data-path tests for Features 2/3/5/6 against the in-memory store
// (no Redis env → makeMemoryStore). Compile lib to CJS first (see unit-upgrades).
// Usage: node scripts/unit-cache.cjs <cjsDir>
const dir = process.argv[2] || ".";
const c = require(`${dir}/cache.js`);
const sd = require(`${dir}/secdiff.js`);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

(async () => {
  console.log("\n— Feature 2: body ownership is NX (first-writer-wins) —");
  const body = "deadbeef".repeat(8); // 64-hex-ish
  const first = await c.claimBodyOwner(body, "ownerA");
  const second = await c.claimBodyOwner(body, "ownerB");
  ok("first claim succeeds", first === true);
  ok("second claim on same body is rejected", second === false);
  ok("owner is the first writer", (await c.getBodyOwner(body)) === "ownerA");

  console.log("\n— Feature 2: alias round-trip —");
  await c.putAlias("reqHashX", "ownerA", body, "same-content");
  const alias = await c.getAlias("reqHashX");
  ok("alias resolves to owner + bodyHash", alias && alias.owner === "ownerA" && alias.bodyHash === body);
  await c.putAlias("ownerA", "ownerA", body); // self-alias must be a no-op
  ok("self-alias is refused", (await c.getAlias("ownerA")) === null);

  console.log("\n— Feature 3: prior section index round-trip —");
  const idx = sd.buildSectionIndex("## A\nx\n## B\ny", 1);
  await c.putPriorSectionIndex("uHash1", "abc123", idx);
  const got = await c.getPriorSectionIndex("uHash1", "abc123");
  ok("prior index stored + retrieved", got && got.sections.length === idx.sections.length);
  ok("miss for unknown hash returns null", (await c.getPriorSectionIndex("uHash1", "nope")) === null);

  console.log("\n— Feature 5: note staleness soft-labelling —");
  const notes = [
    { id: "1", target: "u", kind: "tip", text: "a", votes: 1, at: 1, pinHash: "OLD" },
    { id: "2", target: "u", kind: "tip", text: "b", votes: 1, at: 1, pinHash: "CUR" },
    { id: "3", target: "u", kind: "tip", text: "c", votes: 1, at: 1 }, // unpinned
  ];
  const labelled = c.markStaleNotes(notes, "CUR");
  ok("note pinned to an OLD version is flagged stale", labelled[0].stale === true);
  ok("note pinned to current version is NOT stale", !labelled[1].stale);
  ok("unpinned note is never flagged", !labelled[2].stale);
  ok("no current hash → nothing flagged", c.markStaleNotes(notes, undefined).every((n) => !n.stale));

  console.log("\n— Feature 6: low-yield verdict round-trip —");
  ok("unknown URL has no verdict", (await c.getLowYield("hX")) === null);
  await c.putLowYield("hX", "SPA detected with no public content");
  const ly = await c.getLowYield("hX");
  ok("verdict stored + retrieved", ly && /SPA detected/.test(ly.reason));

  console.log("\n— Feature 2: alias hits flow into stats —");
  const before = (await c.getStats()).aliasHits;
  await c.recordSave(1234, true, "https://example.com/x", true); // alias=true
  const after = (await c.getStats()).aliasHits;
  ok("recordSave(alias=true) increments aliasHits", after === before + 1);
  ok("getStats exposes aliasHits", typeof after === "number");

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
