import type { Metadata } from "next";
import "./globals.css";

const SITE = "https://slipstream-pi.vercel.app";
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

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Slipstream",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any",
  description: DESC,
  url: SITE,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: { "@type": "Person", name: "Tathagat Maitray" },
  softwareHelp: `${SITE}/docs`,
  keywords:
    "MCP, Model Context Protocol, AI agents, LLM, token optimization, shared cache",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
      </body>
    </html>
  );
}
