import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { distill } from "@/lib/distill";
import { getStats } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "cached_fetch",
      "Fetch a web page or docs URL as clean, token-optimized markdown from " +
        "Slipstream's shared cache. The first agent to request a URL pays the " +
        "crawl; every agent after gets the distilled version for ~90% fewer " +
        "tokens. Use this INSTEAD of a raw web fetch whenever you need the " +
        "readable content of a URL.",
      {
        url: z.string().url().describe("The absolute URL to fetch and distill."),
        token_budget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional cap: return at most ~N tokens, clipped on a paragraph boundary.",
          ),
      },
      async ({ url, token_budget }) => {
        try {
          const r = await distill(url, token_budget);
          const pct = r.originalTokens
            ? Math.round((r.tokensSaved / r.originalTokens) * 100)
            : 0;
          const footer =
            `\n\n---\n_Slipstream ${r.cacheHit ? "cache HIT" : "cache MISS (now cached for the next agent)"}` +
            ` · ${r.distilledTokens} tokens returned vs ~${r.originalTokens} raw` +
            ` · saved ~${r.tokensSaved} tokens (${pct}%)_`;
          return { content: [{ type: "text", text: r.markdown + footer }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Slipstream error: ${msg}` }],
            isError: true,
          };
        }
      },
    );

    server.tool(
      "slipstream_stats",
      "Get global Slipstream stats: total tokens saved for AI agents worldwide, " +
        "cache hit rate, and number of pages cached.",
      {},
      async () => {
        const s = await getStats();
        return {
          content: [
            {
              type: "text",
              text:
                `Slipstream global stats\n` +
                `- Tokens saved for agents worldwide: ${s.tokensSaved.toLocaleString()}\n` +
                `- Pages in shared cache: ${s.pagesCached.toLocaleString()}\n` +
                `- Cache hits: ${s.hits.toLocaleString()} / misses: ${s.misses.toLocaleString()}\n` +
                `- Hit rate: ${(s.hitRate * 100).toFixed(1)}%\n` +
                `- Shared backend: ${s.shared ? "yes (Redis)" : "no (in-memory dev)"}`,
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
