# Groundswell — Issues

> **Last Updated:** 2026-06-10

---

## Open

| ID | Priority | Description | Status |
|----|----------|-------------|--------|
| GS-008 | P1 | **Mockup gate (Josh):** review `docs/mockups/2026-06-10-showcase-rank1-v2.html` (preview port 4594) — approval REQUIRED before U9/U10 showcase UI | Open — next action |
| GS-001 | P0 | `U0` ops (Josh): dedicated Supabase project; fine-grained PAT (`Administration`+`Contents`+`Metadata`:Read, scoped to tracked repos, 90-day + rotation reminder); `GITHUB_TOKEN`/`CRON_SECRET`/Supabase keys in all 3 Vercel buckets (`CAPTURE_ENABLED=false`); enable Fluid Compute | Open — gates live capture |
| GS-002 | P1 | `U6` recruiter validation (Josh): 2–3 recruiters react to the refined mockup | Open — gates Phase C |
| GS-003 | P2 | Confirm exact v1 tracked-repo set + killer-project pick (downloads confirmed a real lead signal; numbers ballpark per Josh) | Open (reduced) |
| GS-007 | P3 | Add to `groundswell/CLAUDE.md`: server-only 3-guard, `watchers=subscribers_count`, RLS-deny-all-view, section spacing `padding-top`/`padding-bottom` longhand (never `padding: <v> 0` on a gutter container) | Open |

## Resolved

| ID | Description | Resolution |
|----|-------------|-----------|
| GS-004 | Pin Next major before the session-refresh entry | **Next 16** → `proxy.ts`/`proxy()` (U1) |
| GS-005 | Verify + commit U8 derived metrics | Committed `9219197`; 35 vitest + 16 pgTAP green on real PG |
| GS-006 | Re-verify U4/U7 (committed `--no-verify`) | Full clean `pnpm build` green after U8 |
