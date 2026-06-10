// Empty shim aliased from `server-only` in vitest.config.ts.
// Next.js's `import 'server-only'` package errors at module load when bundled
// into client code. Vitest loads everything in one context (happy-dom). The
// shim is a no-op so server-side modules (src/lib/supabase/admin.ts etc.) can
// be transitively imported in tests without a bundle-context error.
export {}
