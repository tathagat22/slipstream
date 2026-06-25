import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { FAQ } from "@/lib/faq";
import SmoothScroll from "@/components/SmoothScroll";

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});
const geist = Geist({ subsets: ["latin"], display: "swap", variable: "--font-sans" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

const SITE = "https://slipstream-pi.vercel.app";
const REPO = "https://github.com/tathagat22/slipstream";
const DESC =
  "Slipstream is a shared distillation cache for AI agents, delivered over MCP. It clean-crawls a URL once and serves token-optimal markdown shared across every agent — typically 73–89% fewer tokens per fetch.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: "Slipstream — the shared cache for AI agents",
    template: "%s · Slipstream",
  },
  description: DESC,
  keywords: [
    "MCP",
    "Model Context Protocol",
    "MCP server",
    "AI agents",
    "LLM",
    "token optimization",
    "shared cache",
    "web fetch cache",
    "Claude",
    "Cursor",
    "distillation cache",
    "agent tools",
    "Firecrawl alternative",
    "Jina Reader alternative",
    "Context7 alternative",
    "remote MCP server",
    "token-efficient web fetch",
    "url to markdown",
    "Living Web Changelog",
    "whats new since training cutoff",
  ],
  authors: [{ name: "Tathagat Maitray" }],
  creator: "Tathagat Maitray",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "Slipstream",
    title: "Slipstream — the shared cache for AI agents",
    description: DESC,
  },
  twitter: {
    card: "summary_large_image",
    title: "Slipstream — the shared cache for AI agents",
    description: DESC,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  category: "technology",
};

const SOFTWARE_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Slipstream",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any",
  description: DESC,
  url: SITE,
  softwareVersion: "1.0.0",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: { "@type": "Person", name: "Tathagat Maitray" },
  softwareHelp: `${SITE}/docs`,
  sameAs: [REPO, "https://registry.modelcontextprotocol.io"],
  featureList: [
    "cached_fetch — distilled markdown from a shared, content-addressed cache",
    "cached_outline — token-cheap table of contents with per-section cost",
    "slipstream_note — leave a gotcha/correction/tip for every future agent",
    "slipstream_recall — recall what agents learned without fetching the page",
    "slipstream_vote / slipstream_flag — community trust ranking",
    "whats_new — only what changed since your model's training cutoff",
    "slipstream_stats — global tokens saved, hit rate, pages, and notes",
  ],
  keywords:
    "MCP, Model Context Protocol, AI agents, LLM, token optimization, shared cache, Firecrawl alternative, Jina Reader alternative, Context7 alternative",
};

const FAQ_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${geist.variable} ${geistMono.variable}`}
    >
      <body>
        <SmoothScroll />
        {children}
        <div className="grain" aria-hidden="true" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(SOFTWARE_LD) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_LD) }}
        />
      </body>
    </html>
  );
}
