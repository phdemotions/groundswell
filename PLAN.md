# Groundswell — Plan (v2: static-first)

**Status:** Public showcase **BUILT** (2026-06-11). Live deploy gated on GS-001 (Josh).
**Branch:** `feat/scaffold-and-mockups` (own repo, unpushed, tree clean, build green).

---

## Architecture (chosen 2026-06-10): GitHub Pages + Actions + JSON-in-repo

**No Supabase, no Vercel.** GitHub's API has no history (`download_count` is
cumulative; traffic is a 14-day rolling window), so we persist a daily snapshot.
The store is JSON committed to this repo — **git history is the time-series log.**

- **Capture:** `.github/workflows/capture.yml` (daily cron) runs `scripts/capture.ts`
  (reuses the U3 GitHub client) → writes today's `data/<repo>.ndjson` line +
  regenerated backfill → commits → push triggers deploy.
- **Site:** Next.js **static export** (`output: 'export'`) → GitHub Pages via
  `.github/workflows/deploy.yml` (which also runs the CI gate). `page.tsx` SSGs from
  `view.ts`; charts render client-side from the JSON.
- **Private radar (U12):** static can't server-gate → **local-only** (`pnpm dev`,
  reading gitignored `data/.local/`).

---

## Data contract (`data/`) — as built

```
data/meta.json            { repos: [{ name, owner, repo, visibility, displayName, tagline, homepageUrl, trackingStartedAt }], lastCapture }
data/<repo>.ndjson        one line/day: { d, capturedAt, downloads, stars, forks, watchers, releases: { <tag>: count } }
data/backfill/<repo>.json { generatedAt, stars: [{ at }], cadence: [{ tag, publishedAt }] }
data/.local/<repo>.ndjson gitignored — PRIVATE-repo snapshots (radar only; GS-010 guard)
```

Committed store = **public repos only**. The on-disk contract lives in
`src/lib/store/types.ts`; pure transforms in `transform.ts` + `view.ts`.

---

## Units — all built (2026-06-11)

| Unit | What | Where |
|------|------|-------|
| U4′ | JSON-store capture + real seed | `scripts/capture.ts`, `src/lib/store/{types,transform}.ts`, `data/` |
| U8′ | read bridge + view-model + data-driven release chart | `src/lib/store/{read,view}.ts` over `src/lib/metrics/derive.ts` |
| U9 | chart primitives (d3-shape + motion barrel) | `src/components/charts/*` |
| U10 | public showcase (ported design system, live data) | `src/app/{globals.css,layout,page}.tsx`, `src/components/showcase/*` |
| GS-009 | remove v1 Supabase/Vercel/Sentry layer | (deletions) |
| U11′ | static export + Pages/capture workflows | `next.config.ts`, `.github/workflows/*` |
| GS-010 | privacy guard (committed data = public only) | `src/lib/store/privacy.test.ts` |

Carried from v1: U3 GitHub client, `derive.ts`, `runBounded` (kept for future capture fan-out).

---

## Next

- **GS-001 (Josh — deploy gate, ~5 min):** mint fine-grained `GH_PAT`
  (`Administration:Read` + `Contents:Read` + `Metadata:Read`, scoped to tracked
  repos, 90-day + rotation) → repo **secret** · Settings → Pages → **Source: GitHub
  Actions** · (project page only) repo Actions **variable**
  `NEXT_PUBLIC_BASE_PATH=/groundswell` · keep repo **public** (free Actions) · **push
  + merge to main** → `deploy.yml` publishes; run `capture.yml` once for the first
  live snapshot.
- **U12 radar** — local-only what's-growing view (deferred).

---

## Gate (history)

Mockup design **APPROVED** 2026-06-10. Recruiter check (U6) **waived** by Josh
("assume recruiter thinks it's fine").

## Real-data baseline (verified via `gh`, owner `phdemotions`)

- **zotero-citegeist** (public): 576 downloads · 10 stars · 16 releases (live-growing;
  the mockup's 546 was a 2026-06-10 snapshot — the live page always shows current).
- provenance · arbiter.ac (· marginalia): **private, 0 public** → radar-only.
