# Groundswell — Plan (v2: static-first)

**Branch:** `feat/scaffold-and-mockups` (own repo, unpushed).

---

## Architecture (chosen 2026-06-10): GitHub Pages + Actions + JSON-in-repo

**No Supabase, no Vercel.** GitHub's API has no history (`download_count` is
cumulative; traffic is a 14-day rolling window), so we persist a daily snapshot. The
store is JSON committed to this repo — **git history is the time-series log.**

- **Capture:** `.github/workflows/capture.yml` (daily cron) runs `scripts/capture.mjs`
  (reuses the U3 GitHub client) → appends a line to `data/<repo>.ndjson` → commits.
- **Site:** Next.js **static export** (`output: 'export'`) → GitHub Pages via
  `.github/workflows/deploy.yml`. Pages SSG from `derive.ts`; charts render
  client-side from the JSON.
- **Refresh loop:** capture commit → triggers deploy → site rebuilds daily.
- **Private radar (U12):** static can't server-gate → **local-only** (`pnpm dev`,
  reading gitignored `data/.local/`).

---

## Data contract (`data/`)

```
data/meta.json            { repos: [{ name, owner, visibility, trackingStartedAt }], lastCapture }
data/<repo>.ndjson        one line/day: { d, downloads, stars, forks, watchers, releases: { <tag>: count } }
data/backfill/<repo>.json { stars: [{ d, total }], cadence: [{ tag, publishedAt }] }
data/.local/<repo>.ndjson gitignored — private-repo snapshots (radar only)
```

Public store commits **public repos only**. Private-repo metrics never enter
committed JSON (GS-010 guard test).

---

## Units

**PORT (keep, repoint to JSON):** U3 GitHub client · U7 backfill (writes JSON) ·
U8 `derive.ts` (reads NDJSON) · `runBounded` · domain types.

**DEPRECATE (remove — GS-009 pivot commit):** U1 Supabase clients ·
U2 SQL schema/RLS/views · U4 Vercel cron route + watchdog · `proxy.ts` ·
`env.ts` Supabase/`CRON_SECRET` gating · `admin-import-barrier` test · `vercel.json` ·
`supabase/` · `@supabase/*` + `server-only` deps.

**BUILD (next):**
1. **GS-009** — pivot: strip the Supabase/Vercel layer; repoint backfill + derive to JSON.
2. **U4′** capture: `scripts/capture.mjs` + `.github/workflows/capture.yml` (cron → NDJSON commit); `data/meta.json`.
3. **U8′** derive reads NDJSON (+ cold-start / backfill merge).
4. **U9** chart primitives — `d3-shape` + `motion` + SVG barrel (HTML stat numbers, portal tooltips). Unchanged by the pivot.
5. **U10** static showcase — SSG from JSON, ports `showcase-real.html` to the pixel.
6. **U11′** deploy: `output: 'export'` + `.github/workflows/deploy.yml` → Pages (CI runs here).
7. **U12** radar — local-only, deferred.

Each unit: implement → `/simplify` → `/deslop` → `/thermo-nuclear` → commit.

---

## Gate

Mockup design **APPROVED** 2026-06-10. Recruiter check (U6) **waived**
(Josh: "assume recruiter thinks it's fine"). → Build the static path now.

---

## Ops — GS-001′ (Josh, much smaller than v1)

- Mint fine-grained **PAT** (`Administration:Read` + `Contents:Read` +
  `Metadata:Read`, scoped to tracked repos, 90-day + rotation) → repo secret `GH_PAT`.
- Enable **GitHub Pages** (Source: GitHub Actions).
- Populate `data/meta.json` (tracked repos · visibility · trackingStartedAt).
- Keep the repo **public** → Actions free. (Optional: custom domain; else project-page
  `basePath=/groundswell`.)

---

## Real data baseline (verified via `gh`, owner `phdemotions`)

- **zotero-citegeist** (public): 546 downloads · 10 stars · 16 releases
  (v1.3.0=274, v2.0.2=116, v2.0.0=61, v2.0.1=23, v1.0.0=17, v1.2.0=35, others single/low).
- provenance · arbiter.ac · marginalia: **private, 0 public** (radar-only).
- glimpse: public, 0 releases. stemma: no GitHub remote.
