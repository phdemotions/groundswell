# Groundswell — Issues

> **Last Updated:** 2026-06-10

---

## Open

| ID | Priority | Description | Status |
|----|----------|-------------|--------|
| GS-009 | P1 | **Pivot to static-first** — remove the Supabase/Vercel layer (`src/lib/supabase/*`, `supabase/migrations/*`, `src/app/api/cron/*`, `proxy.ts`, `env.ts` secret-gating, `admin-import-barrier` test, `vercel.json`, `@supabase/*` + `server-only` deps); repoint backfill + `derive.ts` to JSON. Lands with the U4′ capture build. | Open — next (build) |
| GS-001 | P0 | `U0` ops (Josh): mint fine-grained PAT (`Administration`+`Contents`+`Metadata`:Read, scoped, 90-day + rotation) → repo secret `GH_PAT`; enable GitHub Pages (Source: Actions); populate `data/meta.json`; keep repo public (free Actions) | Open — gates live capture |
| GS-010 | P1 | **Privacy guard:** capture commits PUBLIC repos only; private-repo metrics → gitignored `data/.local/`. Add a test that fails if any private-repo metric appears in committed `data/`. | Open — build with U4′ |
| GS-003 | P2 | Populate `data/meta.json` — final tracked-repo set + visibility + `trackingStartedAt`; confirm killer-project pick (citegeist) | Open (Josh) |

## Resolved

| ID | Description | Resolution |
|----|-------------|-----------|
| GS-004 | Pin Next major before the session-refresh entry | **Next 16** (note: `proxy.ts` itself is dropped in the GS-009 pivot — static site, no session middleware) |
| GS-005 | Verify + commit U8 derived metrics | Committed `9219197`; logic ports to JSON in U8′ |
| GS-006 | Re-verify U4/U7 (committed `--no-verify`) | Full clean `pnpm build` green after U8 |
| GS-008 | Mockup design gate (Josh) | **Design approved 2026-06-10** ("looks good enough") — canonical `docs/mockups/2026-06-10-showcase-real.html`: real numbers, de-echoed, full-width, pixel-aligned, quiet editorial "Shipping next". |
| GS-007 | Fold hard-won conventions into `groundswell/CLAUDE.md` | Product-invariants · GitHub data-model gotchas · privacy boundary · Design-conventions (updated for the static-first pivot 2026-06-10). |
| GS-002 | `U6` recruiter validation (Josh) | **Waived by Josh 2026-06-10** ("assume recruiter thinks it's fine"). U9→U10 build unblocked. |

---

## Architecture note

Pivoted 2026-06-10 from Supabase + Vercel to **GitHub Pages + Actions + JSON-in-repo**
(see `PLAN.md`). Capture + backfill + derive logic ports; the data sink (Postgres→JSON)
and host (Vercel→Pages) change. The v1 Supabase scaffold is removed in GS-009.
