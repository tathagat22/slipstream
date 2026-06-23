// Pure unit tests for the new Living-Web-Changelog core logic (Feature 1 section
// index + diff, Feature 2 canonicalization). Compile the TS to CJS first:
//   npx tsc lib/secdiff.ts lib/canonical.ts lib/tokens.ts --module commonjs \
//     --target es2022 --moduleResolution node --rootDir lib --outDir <dir> --skipLibCheck
// then: node scripts/unit-upgrades.cjs <dir>
const dir = process.argv[2] || ".";
const sd = require(`${dir}/secdiff.js`);
const cn = require(`${dir}/canonical.js`);

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
};

const MD = `intro text here
## Install
run npm install foo
### macOS
brew install foo
## Usage
call foo() to start
## Advanced
deep config here`;

console.log("\n— secdiff.buildSectionIndex —");
const idx = sd.buildSectionIndex(MD, 1000);
ok("returns v:1 index", idx && idx.v === 1);
ok("includes (intro) + 4 headings", idx.sections.length === 5);
ok("every section has a 64-hex sha256", idx.sections.every((s) => /^[0-9a-f]{64}$/.test(s.sha256)));
ok("outline excludes (intro)", idx.outline.every((o) => o.heading !== "(intro)"));
ok("outline keeps level<=3 only", idx.outline.every((o) => o.level <= 3));

console.log("\n— determinism + stability (the cross-agent fingerprint guarantee) —");
const idx2 = sd.buildSectionIndex(MD, 2000);
const hashes = (i) => Object.fromEntries(i.sections.map((s) => [s.heading, s.sha256]));
const h1 = hashes(idx);
const h2 = hashes(idx2);
ok("identical markdown → identical section hashes", Object.keys(h1).every((k) => h1[k] === h2[k]));

const MD_CHANGED = MD.replace("call foo() to start", "call foo(opts) to begin — NEW");
const idx3 = sd.buildSectionIndex(MD_CHANGED, 3000);
const h3 = hashes(idx3);
ok("changing one section changes ONLY that hash (Usage)", h3["Usage"] !== h1["Usage"]);
ok("untouched sections keep identical hashes (Install/macOS/Advanced)",
  h3["Install"] === h1["Install"] && h3["macOS"] === h1["macOS"] && h3["Advanced"] === h1["Advanced"]);

console.log("\n— sectionBodyFromIndex == extractSection (no behavior regression) —");
for (const heading of ["Install", "Usage", "Advanced"]) {
  const fromIndex = sd.sectionBodyFromIndex(idx, heading);
  const live = sd.extractSection(MD, heading);
  ok(`section "${heading}" identical via index and live parse`, fromIndex === live);
}
ok("Install carries its macOS subsection (parent-carries-children)",
  sd.sectionBodyFromIndex(idx, "Install").includes("brew install foo"));

console.log("\n— diffSectionIndexes (the flagship delta) —");
const delta = sd.diffSectionIndexes(idx, idx3);
ok("exactly 1 changed section", delta.changed.length === 1);
ok("changed section is Usage", delta.changed[0] && delta.changed[0].heading === "Usage");
ok("4 unchanged (intro, Install, macOS, Advanced)", delta.unchangedCount === 4);
ok("nothing added/removed", delta.added.length === 0 && delta.removed.length === 0);

const MD_STRUCT = MD + "\n## Troubleshooting\nturn it off and on";
const idx4 = sd.buildSectionIndex(MD_STRUCT, 4000);
const delta2 = sd.diffSectionIndexes(idx, idx4);
ok("added section detected", delta2.added.some((s) => s.heading === "Troubleshooting"));
const delta3 = sd.diffSectionIndexes(idx4, idx);
ok("removed section detected", delta3.removed.some((r) => r.heading === "Troubleshooting"));

console.log("\n— bounds (Redis-bloat guards) —");
const many = Array.from({ length: 60 }, (_, i) => `## H${i}\nbody ${i}`).join("\n");
ok("over SECTION_INDEX_MAX_SECTIONS → undefined", sd.buildSectionIndex(many, 1) === undefined);
const huge = `## Big\n${"x".repeat(700_000)}`;
ok("over SECTION_INDEX_MAX_BYTES → undefined", sd.buildSectionIndex(huge, 1) === undefined);

console.log("\n— canonical.canonicalize (Feature 2 dedup keys) —");
const c1 = cn.canonicalize("https://www.Example.com/docs/?utm_source=x&gclid=y&keep=1");
ok("drops www + lowercases host", c1.canonicalUrl.startsWith("https://example.com/"));
ok("strips utm_source + gclid", !/utm_source|gclid/.test(c1.canonicalUrl));
ok("keeps non-tracking param", /keep=1/.test(c1.canonicalUrl));
ok("strips trailing slash", !c1.canonicalUrl.replace(/\?.*$/, "").endsWith("/"));

const c2 = cn.canonicalize("https://evil-mirror.com/abs/1706.03762");
ok("non-allowlisted host left untouched (no mirror)", c2.kind !== "mirror" && c2.fetchUrl.includes("evil-mirror.com"));

const c3 = cn.canonicalize("https://ar5iv.labs.arxiv.org/html/1706.03762");
ok("vetted mirror ar5iv.labs → ar5iv.org", c3.kind === "mirror" && c3.fetchUrl.includes("ar5iv.org"));

const c4 = cn.canonicalize("ftp://example.com/file");
ok("non-http(s) scheme returned raw (never crawled as mirror)", c4.kind === "raw");

const c5 = cn.canonicalize("not a url");
ok("invalid URL falls back to raw", c5.kind === "raw" && c5.fetchUrl === "not a url");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
