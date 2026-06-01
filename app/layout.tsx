import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Slipstream — the shared cache for AI agents",
  description:
    "Every agent makes the web cheaper for the next. A shared, token-optimized distillation cache for AI agents, delivered over MCP.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
