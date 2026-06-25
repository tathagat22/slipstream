/** Shared FAQ — rendered visibly on the homepage and emitted as FAQPage JSON-LD. */
export const FAQ: { q: string; a: string }[] = [
  {
    q: "What is an MCP shared cache?",
    a: "Slipstream is a hosted MCP (Model Context Protocol) server that clean-crawls a URL once, distills it to token-optimal markdown, and serves that distillation content-addressed and shared across every agent. The first agent to hit a URL pays the crawl; every agent after gets the same clean result for ~73–89% fewer tokens.",
  },
  {
    q: "How do I cut my AI agent's web-fetch token cost?",
    a: "Point your agent at Slipstream's MCP endpoint and call cached_fetch(url) instead of a raw web fetch. You get clean markdown from a shared cache, an optional token_budget to cap context server-side, and known_hash to receive only the sections that changed since the version you last saw.",
  },
  {
    q: "How is Slipstream different from Firecrawl or Jina Reader?",
    a: "Per-call cleaners return a fresh single-session snapshot every time. Slipstream's cache is shared across every agent and content-addressed, and it computes heading-level diffs across agents — so you also learn what changed since the version you cited, for ~0 tokens. No stateless fetcher can answer that.",
  },
  {
    q: "Is Slipstream free?",
    a: "Yes. It's a hosted, remote MCP server — nothing to install or deploy, free to use, and fully open source (MIT) if you want to run your own instance.",
  },
  {
    q: "Which clients work with Slipstream?",
    a: "Any MCP client: Claude Code, Cursor, Windsurf, and VS Code add it with one line; Claude Desktop bridges the remote server via mcp-remote. There is nothing to run locally.",
  },
];
