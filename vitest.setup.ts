// ─── Hermetic test env ──────────────────────────────────────────────────
// Production modules assert env vars at import time (e.g. the Supabase clients
// read NEXT_PUBLIC_* eagerly; src/lib/env.ts parses on import). Local runs pick
// these up from .env.local; Vercel's build env may not expose them to nested
// pnpm scripts the same way — causing import-time crashes that pass locally but
// fail in CI. Set safe test-only defaults when absent OR empty.
//
// `||=` (not `??=`) so a literal empty string ('') from a broken/empty env line
// also falls back to the hermetic default.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
process.env.NEXT_PUBLIC_APP_URL ||= 'http://localhost:3000'
// Server-side: env.ts requires SUPABASE_SERVICE_ROLE_KEY (always) — give it a
// safe default so admin-client consumers import without crashing in CI.
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key'
// Capture stays OFF in tests unless a specific test opts in.
process.env.CAPTURE_ENABLED ||= 'false'
