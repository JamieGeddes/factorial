import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages are TypeScript source.
  transpilePackages: ['@factorial/live', '@factorial/artefacts'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Nothing is cached on disk or served from a CDN: every page is rendered per request (the CSP nonce needs it).
  images: { unoptimized: true },
};

export default config;
