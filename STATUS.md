# Groundswell — Status

> **Last Updated:** 2026-06-11
> **Phase:** Public showcase BUILT + shippable (static-first). Live deploy gated on GS-001 (Josh).
> **Build:** Full `pnpm build` GREEN — static export to `out/`; 105 tests; tree clean.

---

## Current State

| Attribute | Value |
|-----------|-------|
| Architecture | **Static-first** — GitHub Pages + Actions + JSON-in-repo. NO Supabase, NO Vercel, NO server. |
| Stack | Next 16 (App Router, `output: 'export'`) · React 19 · TS strict · Tailwind v4 · next/font · hand-rolled d3-shape + motion charts |
| Data | Daily GitHub Action → `data/<repo>.ndjson` (git = time-series log). Real: citegeist **576 dl / 10★ / 16 releases** (live-growing). Privates → gitignored `data/.local/`. |
| Repo | `~/developer/groundswell`, branch `feat/scaffold-and-mockups`, unpushed, tree clean |
| Live capture + deploy | Gated on **GS-001** (Josh): `GH_PAT` secret · enable Pages · merge to main |
| Plan | `PLAN.md` (v2 static-first). Canonical mockup: `docs/mockups/2026-06-10-showcase-real.html` |

---

## Built (committed, build green)

**Static-first build (2026-06-11):**
- **U4′** capture — `scripts/capture.ts` (reuses U3 GitHub client) + `data/meta.json`; pure transforms (`src/lib/store/transform.ts`) tested; real citegeist seed.
- **U8′** read bridge — `read.ts` (public-only loader) + `view.ts` (`buildShowcaseModel` + data-driven `buildReleaseChart`) over the unchanged pure `derive.ts`.
- **U9** chart primitives — `AreaCurve` + `BarChart` (d3-shape + motion, behind a barrel) + portal tooltip; pure scales/geometry tested.
- **U10** public showcase — design system ported verbatim to `globals.css`; `page.tsx` SSG from the model; sections + sr-only a11y table; every number real.
- **GS-009** — removed the v1 Supabase/Vercel/Sentry layer (−7.7k LOC).
- **U11′** — `output: 'export'` + `.github/workflows/{deploy,capture}.yml`.
- **GS-010** — privacy guard test: committed `data/` = public repos only.

Carried from v1 (still used): U3 GitHub client, `derive.ts`, `runBounded`.

## Next

- **GS-001** (Josh, ~5 min, all on GitHub) — mint `GH_PAT` (Administration+Contents+Metadata:Read, scoped, 90-day) → repo secret · Settings → Pages → Source: GitHub Actions · (project page only) repo Actions var `NEXT_PUBLIC_BASE_PATH=/groundswell` · push + merge to main → `deploy.yml` publishes.
- **U12** private radar — local-only "what's growing", deferred.

## Recent Sessions

| # | Date | What |
|---|------|------|
| 1 | 2026-06-10 | Brainstorm → plan (v2, 7-persona review) → memory |
| 2 | 2026-06-10 | ce-work Phase A (v1 Supabase): U1–U5, U7, U8 committed |
| 3 | 2026-06-11 | Shipping-next polish → mockup gate approved → **static-first pivot** → built U4′ · U8′ · U9 · U10 · GS-009 cleanup · U11′ export + workflows · GS-010 guard |
