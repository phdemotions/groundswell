# Groundswell — Issues

> **Last Updated:** 2026-06-11

---

## Open

| ID | Priority | Description | Status |
|----|----------|-------------|--------|
| GS-001 | P0 | **Deploy gate (Josh, ~2 min — NO PAT):** Settings → Pages → Source: GitHub Actions; (project page only) repo Actions vars `NEXT_PUBLIC_BASE_PATH=/groundswell` + `NEXT_PUBLIC_SITE_URL=https://<user>.github.io/groundswell`; keep repo public; push + merge to main → `site.yml` builds + deploys (the daily run also captures + redeploys). Capture uses the built-in Actions token (public data only). | Open — gates live deploy |
| GS-011 | P3 | **U12 private radar** — local-only "what's growing" view reading `data/.local/` (`pnpm dev`). Deferred. | Open — deferred |
| GS-012 | P4 | citegeist has a stray release tagged literally `release` (shows as a `release` bar). Optional: retag it on GitHub for a cleaner axis — the page faithfully shows reality either way. | Open — optional (Josh) |

## Resolved

| ID | Description | Resolution |
|----|-------------|-----------|
| GS-004 | Pin Next major before the session-refresh entry | **Next 16**; `proxy.ts` later dropped in the static-first pivot (no server middleware) |
| GS-005 | Verify + commit U8 derived metrics | `derive.ts` ported unchanged to the JSON read path (U8′) |
| GS-006 | Re-verify U4/U7 (committed `--no-verify`) | superseded by the static-first rebuild |
| GS-008 | Mockup design gate (Josh) | **Approved 2026-06-10** — canonical `docs/mockups/2026-06-10-showcase-real.html` |
| GS-007 | Fold conventions into `groundswell/CLAUDE.md` | Done (updated for static-first) |
| GS-002 | `U6` recruiter validation (Josh) | **Waived 2026-06-10** ("assume recruiter thinks it's fine") |
| GS-009 | Pivot: remove the Supabase/Vercel/Sentry layer | Done — commit `fe76c78` (−7.7k LOC); CI now runs in `deploy.yml` |
| GS-010 | Privacy guard: committed `data/` = public repos only | Done — `src/lib/store/privacy.test.ts` (3 tests; private repos confined to gitignored `data/.local/`) |
| GS-003 | Populate `data/meta.json` roster | Done for v1 — citegeist (public) + provenance + arbiter.ac (private); expand later if needed |

---

## Architecture note

Static-first (2026-06-11): GitHub Pages + Actions + JSON-in-repo. The capture +
`derive.ts` logic carried over; the data sink (Postgres → JSON) and host (Vercel →
Pages) changed. The v1 Supabase scaffold was removed in GS-009. See `PLAN.md`.
