import type { Metadata } from "next";
import { INSTALL, MCP_URL } from "@/lib/install";

const SITE = "https://slipstream-pi.vercel.app";

export const metadata: Metadata = {
  title: "Install Slipstream — add the remote MCP server in one line",
  description:
    "Add Slipstream to Claude Code, Cursor, Windsurf, VS Code, or Claude Desktop. A hosted, remote MCP server — copy one line, nothing to deploy.",
  alternates: { canonical: "/install" },
  openGraph: {
    type: "article",
    url: `${SITE}/install`,
    title: "Install Slipstream — remote MCP server, one line",
    description:
      "Add the Slipstream MCP server to Claude Code, Cursor, Windsurf, VS Code, or Claude Desktop in seconds.",
  },
};

const methods = Object.values(INSTALL);

const HOWTO_LD = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "Install the Slipstream MCP server",
  description:
    "Add Slipstream — a shared distillation cache for AI agents — to your MCP client.",
  totalTime: "PT30S",
  tool: [{ "@type": "HowToTool", name: "An MCP client (Claude Code, Cursor, Windsurf, VS Code, or Claude Desktop)" }],
  step: methods.map((m, i) => ({
    "@type": "HowToStep",
    position: i + 1,
    name: m.label,
    text: m.step,
    itemListElement: [{ "@type": "HowToDirection", text: m.code }],
  })),
};

const BREADCRUMB_LD = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE },
    { "@type": "ListItem", position: 2, name: "Install", item: `${SITE}/install` },
  ],
};

export default function InstallPage() {
  return (
    <main className="wrap">
      <header className="top">
        <span className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brandmark" src="/mark.svg" alt="" width={24} height={24} />
          slipstream
        </span>
        <nav className="topnav">
          <a className="ghlink" href="/">Home</a>
          <a className="ghlink" href="/docs">Docs</a>
          <a className="ghlink" href="https://github.com/tathagat22/slipstream">
            GitHub ↗
          </a>
        </nav>
      </header>

      <span className="eyebrow">Install · 30 seconds</span>
      <h1>Add Slipstream in one line.</h1>
      <h2 className="subhead">
        Slipstream is a hosted, <strong>remote MCP server</strong> — point any
        MCP client at the endpoint and call <code>cached_fetch</code> instead of
        a raw web fetch. Nothing to deploy.
      </h2>
      <p className="lede">
        Endpoint (Streamable HTTP): <code>{MCP_URL}</code>
      </p>

      <div className="install">
        {methods.map((m) => (
          <section className="reveal in" key={m.label} style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: "clamp(20px, 2.6vw, 26px)" }}>{m.label}</h2>
            <p className="installnote" style={{ marginBottom: 10 }}>{m.step}</p>
            <pre>{m.code}</pre>
          </section>
        ))}
      </div>

      <p className="lede">
        Then your agent has <code>cached_fetch</code>, <code>whats_new</code>,
        the hive-brain note tools, and the rest. See the{" "}
        <a href="/docs">full tool reference →</a>
      </p>

      <footer>
        <span className="dot" /> Slipstream · <a href="/">home</a> ·{" "}
        <a href="/docs">docs</a> ·{" "}
        <a href="https://github.com/tathagat22/slipstream">source</a>
      </footer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(HOWTO_LD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(BREADCRUMB_LD) }}
      />
    </main>
  );
}
