import type { MetadataRoute } from "next";

const SITE = "https://slipstream-pi.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE}/docs`, changeFrequency: "weekly", priority: 0.8 },
  ];
}
