# Groundswell — Issues

> **Last Updated:** 2026-06-10

---

## Open

| ID | Priority | Description | Status |
|----|----------|-------------|--------|
| GS-001 | P0 | `U0` ops (Josh): dedicated Supabase project; fine-grained PAT (`Administration`+`Contents`+`Metadata`:Read, scoped to tracked repos, 90-day + rotation reminder); `GITHUB_TOKEN`/`CRON_SECRET`/Supabase keys in all 3 Vercel buckets (`CAPTURE_ENABLED=false`); enable Fluid Compute | Open — gates live capture |
| GS-002 | P1 | `U6` recruiter validation (Josh): 2–3 recruiters react to the approved mockup (`docs/mockups/2026-06-10-showcase-real.html`) — **now the active gate for the U9→U10 heavy build** | Open — next action |
| GS-003 | P2 | Confirm exact v1 tracked-repo set + killer-project pick (downloads confirmed a real lead signal; numbers ballpark per Josh) | Open (reduced) |
## Resolved

| ID | Description | Resolution |
|----|-------------|-----------|
| GS-004 | Pin Next major before the session-refresh entry | **Next 16** → `proxy.ts`/`proxy()` (U1) |
| GS-005 | Verify + commit U8 derived metrics | Committed `9219197`; 35 vitest + 16 pgTAP green on real PG |
| GS-006 | Re-verify U4/U7 (committed `--no-verify`) | Full clean `pnpm build` green after U8 |
| GS-008 | Mockup design gate (Josh) | **Design approved 2026-06-10** ("looks good enough") — canonical `docs/mockups/2026-06-10-showcase-real.html`: real numbers, de-echoed, full-width, pixel-aligned, quiet editorial "Shipping next". Heavy U9→U10 build now gated by GS-002. |
| GS-007 | Fold hard-won conventions into `groundswell/CLAUDE.md` | Product-invariants (no hardcoded numbers · honesty-first · de-echo · canonical mockup), GitHub data-model gotchas (`watchers=subscribers_count` · cumulative downloads · 14-day self-heal · non-additive uniques · backfillable stars · least-priv PAT), RLS-deny-all view bullet, Design-conventions (full-width · padding longhand · single-renderer charts · quiet-unearned · honesty cues · U5 tokens). |
