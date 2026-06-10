# Groundswell — Issues

> **Last Updated:** 2026-06-10

---

## Open

| ID | Priority | Description | Status |
|----|----------|-------------|--------|
| GS-001 | P0 | `U0` ops (Josh, manual): create dedicated Supabase project; mint fine-grained PAT (`Administration:Read` + `Contents:Read` + `Metadata:Read`, scoped to tracked repos, 90-day TTL + rotation reminder); set `GITHUB_TOKEN`/`CRON_SECRET`/Supabase keys in all 3 Vercel buckets (`CAPTURE_ENABLED=false`); enable Fluid Compute | Open — gates live capture |
| GS-002 | P1 | `U6` recruiter validation gate (Josh): line up 2–3 recruiters/hiring managers to react to the realistic-data mockup before the heavy build | Open — gates Phase C |
| GS-003 | P2 | Confirm exact v1 tracked-repo set + killer-project pick; verify each ships GitHub Release assets (downloads is the lead signal) | Open — citegeist/provenance seed |
| GS-004 | P2 | Pin Next major before writing the Supabase session-refresh entry — `proxy.ts`/`proxy()` on Next 16, `middleware.ts` on Next 15 | Open — decide in `U1` |
