import type { MetadataRoute } from "next";

const SITE = "https://slipstream-pi.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  // Only list pages that actually exist — add /vs/*, /living-web-changelog and
  // /blog/* here as they ship (see DISCOVERABILITY.md roadmap).
  return [
    { url: `${SITE}/`, changeFrequency: "daily", priority: 1 },
    { url: `${SITE}/install`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${SITE}/docs`, changeFrequency: "weekly", priority: 0.8 },
  ];
}
