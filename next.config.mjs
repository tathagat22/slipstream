/** @type {import('next').NextConfig} */
const nextConfig = {
  // jsdom must run in the Node runtime, not bundled — keep it external.
  serverExternalPackages: ["jsdom", "@mozilla/readability"],
};

export default nextConfig;
