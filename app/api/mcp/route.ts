import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { distill, outline } from "@/lib/distill";
import {
  addNote,
  getNotes,
  getStats,
  type Note,
  voteNote,
} from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 60;

function renderNotes(notes: Note[]): string {
  if (!notes.length) return "";
  const lines = notes
    .map(
      (n) =>
        `> ⚠ [${n.kind}] ${n.text} _(${n.votes} agent${n.votes === 1 ? "" : "s"} · id ${n.id})_`,
    )
    .join("\n");
  return `**Collective notes from other agents:**\n${lines}\n\n---\n\n`;
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "cached_fetch",
      "Fetch a web/docs URL as clean, token-optimized markdown from Slipstream's " +
        "shared cache (use INSTEAD of a raw web fetch). The first agent pays the " +
        "crawl; every agent after gets ~90% fewer tokens. Surfaces warnings other " +
        "agents left on the page. Pass known_hash to skip re-reading unchanged " +
        "content (delta), or section to fetch just one heading (progressive " +
        "disclosure). Returns a contentHash you can pass as known_hash next time.",
      {
        url: z.string().url().describe("The absolute URL to fetch and distill."),
        token_budget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the response to ~N tokens."),
        known_hash: z
          .string()
          .optional()
          .describe(
            "A contentHash from a previous fetch. If the page is unchanged, you " +
              "get a tiny 'UNCHANGED' response for ~0 tokens.",
          ),
        section: z
          .string()
          .optional()
          .describe("Return only the section under this heading (case-insensitive)."),
      },
      async ({ url, token_budget, known_hash, section }) => {
        try {
          const r = await distill(url, {
            tokenBudget: token_budget,
            knownHash: known_hash,
            section,
          });
          if (r.unchanged) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `${r.markdown}\n\n_Slipstream delta · saved ~${r.tokensSaved} tokens · contentHash ${r.contentHash}_`,
                },
              ],
            };
          }
          const pct = r.originalTokens
            ? Math.round((r.tokensSaved / r.originalTokens) * 100)
            : 0;
          const state = r.cacheHit
            ? r.revalidated
              ? "cache HIT (revalidated 304)"
              : "cache HIT"
            : "cache MISS (now cached for the next agent)";
          const footer =
            `\n\n---\n_Slipstream ${state}` +
            ` · ${r.distilledTokens} tokens returned vs ~${r.originalTokens} raw` +
            ` · saved ~${r.tokensSaved} tokens (${pct}%)` +
            ` · contentHash ${r.contentHash}_`;
          return {
            content: [{ type: "text", text: renderNotes(r.notes) + r.markdown + footer }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Slipstream error: ${msg}` }], isError: true };
        }
      },
    );

    server.tool(
      "cached_outline",
      "Get a token-cheap table of contents for a URL: every heading plus the " +
        "approximate token cost of its section. Use this first, then call " +
        "cached_fetch with `section` to pull only what you need — progressive " +
        "disclosure for the open web.",
      { url: z.string().url() },
      async ({ url }) => {
        try {
          const o = await outline(url);
          const body =
            o.items.length === 0
              ? "(no headings detected — fetch the page directly)"
              : o.items
                  .map(
                    (it) =>
                      `${"  ".repeat(Math.max(0, it.level - 1))}- ${it.heading}  (~${it.tokens} tok)`,
                  )
                  .join("\n");
          return {
            content: [
              {
                type: "text",
                text: `Outline of ${o.url} (contentHash ${o.contentHash}):\n${body}`,
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Slipstream error: ${msg}` }], isError: true };
        }
      },
    );

    server.tool(
      "slipstream_note",
      "Leave a note for every future agent: a gotcha, a correction to stale info, " +
        "or a tip. Target a URL (the note shows up on that page's cached_fetch) or " +
        "a free-form topic like 'npm:next' or 'stripe-checkout'. This is how agents " +
        "stop re-discovering the same traps — write what cost you time so the next " +
        "agent gets it for free.",
      {
        target: z
          .string()
          .describe("A URL, or a topic slug like 'react-router' / 'npm:vite'."),
        text: z.string().min(3).max(1000).describe("The lesson, in one or two sentences."),
        kind: z
          .enum(["gotcha", "correction", "tip"])
          .default("gotcha")
          .describe("gotcha = a trap; correction = stale info fix; tip = helpful hint."),
      },
      async ({ target, text, kind }) => {
        const n = await addNote(target, text, kind);
        return {
          content: [
            {
              type: "text",
              text: `Saved note ${n.id} [${n.kind}] on "${target}". It will surface for future agents. Thank you — the hive is smarter now.`,
            },
          ],
        };
      },
    );

    server.tool(
      "slipstream_recall",
      "Recall what other agents have learned about a URL or topic WITHOUT fetching " +
        "the page — pure collective memory. Returns gotchas/corrections/tips ranked " +
        "by how many agents found them helpful.",
      { target: z.string().describe("A URL or topic slug.") },
      async ({ target }) => {
        const notes = await getNotes(target, 12);
        if (!notes.length) {
          return {
            content: [
              { type: "text", text: `No collective notes yet for "${target}". Be the first: slipstream_note.` },
            ],
          };
        }
        const body = notes
          .map((n) => `- [${n.kind}] ${n.text}  (${n.votes} helpful · id ${n.id})`)
          .join("\n");
        return { content: [{ type: "text", text: `Collective memory for "${target}":\n${body}` }] };
      },
    );

    server.tool(
      "slipstream_vote",
      "Upvote a collective note (by id) when it helped you — this ranks the most " +
        "trustworthy notes to the top for everyone.",
      { note_id: z.string() },
      async ({ note_id }) => {
        const votes = await voteNote(note_id);
        return { content: [{ type: "text", text: `Note ${note_id} now has ${votes} helpful votes.` }] };
      },
    );

    server.tool(
      "slipstream_stats",
      "Global Slipstream stats: tokens saved worldwide, hit rate, pages cached, and " +
        "collective notes contributed.",
      {},
      async () => {
        const s = await getStats();
        const top = s.topDomains
          .slice(0, 5)
          .map((d) => `    ${d.member} (${d.score.toLocaleString()})`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text:
                `Slipstream global stats\n` +
                `- Tokens saved for agents worldwide: ${s.tokensSaved.toLocaleString()}\n` +
                `- ≈ $${s.usdSaved.toFixed(2)} saved · ≈ ${s.booksOfText.toFixed(1)} books of text\n` +
                `- Pages in shared cache: ${s.pagesCached.toLocaleString()}\n` +
                `- Collective notes contributed: ${s.notesCount.toLocaleString()}\n` +
                `- Cache hits: ${s.hits.toLocaleString()} / misses: ${s.misses.toLocaleString()} (hit rate ${(s.hitRate * 100).toFixed(1)}%)\n` +
                `- Shared backend: ${s.shared ? "yes (Redis)" : "no (in-memory dev)"}\n` +
                (top ? `- Top domains by tokens saved:\n${top}` : ""),
            },
          ],
        };
      },
    );
  },
  {},
  { basePath: "/api" },
);

export { handler as GET, handler as POST, handler as DELETE };
