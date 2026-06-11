import type { NextConfig } from 'next'

/**
 * Static-first (U11′). `output: 'export'` produces a fully static `out/` for
 * GitHub Pages — no server, no API routes (the Supabase capture route was removed
 * in GS-009; capture now runs in a GitHub Action). `basePath` is set via env for a
 * project Pages site (e.g. `/groundswell`); empty for a custom domain or local dev.
 *
 * Note: static export can't run Next `headers()`, so security headers are not set
 * here — GitHub Pages serves its own. (A future move to an edge/CDN host could
 * reintroduce them.)
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
  basePath: basePath || undefined,
  images: { unoptimized: true },
}

export default config
