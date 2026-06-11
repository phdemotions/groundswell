# Groundswell

**A recruiter-facing showcase of the real GitHub traction behind the research tools I build.**

It leads with one honest absolute number, tells the shipping-cadence story, and
claims nothing it hasn't earned — every figure is pulled live from the GitHub API,
never hardcoded.

> Live: _set after deploy_ · Author: **Josh Gonzales**

---

## The idea

Most "download badge" tools show a single number with no story. Groundswell turns a
developer's public GitHub adoption into a page a hiring manager actually wants to
read: a real aggregate, a reconstructed growth curve, and per-release download bars
that show *how relentlessly the work ships* — plus an honest, number-free list of
what's coming next.

## How it works — static-first, no database, no server

GitHub's API has **no history** (release `download_count` is a running total;
traffic is a 14-day rolling window). So something has to persist a daily snapshot.
Groundswell uses the cheapest thing that does: **the git repo itself.**

```
┌─ GitHub Action (daily cron) ─────────────┐      ┌─ GitHub Action (on push) ─┐
│ scripts/capture.ts                        │      │ deploy.yml                │
│   GitHub API → data/<repo>.ndjson  ──────────►   │ build (CI gate) → Pages   │
│   commit + push                           │      └───────────────────────────┘
└───────────────────────────────────────────┘                  │
        git history = the time-series log                       ▼
                                                    static site reads the JSON
```

- **Capture** — a daily Action fetches each tracked repo and appends one line to
  `data/<repo>.ndjson`. Git history *is* the time-series log.
- **Site** — a Next.js **static export** (`output: 'export'`) reads that JSON at
  build time and renders to GitHub Pages. No server, no runtime secrets.
- **Refresh loop** — the capture commit triggers the deploy, so the page updates
  itself daily.

No Supabase, no Vercel, no database. The only secret is a read-only GitHub PAT used
inside the capture Action.

## Honesty by construction

- **Nothing is hardcoded.** Every number renders from the captured JSON via a pure
  derive layer. If a number can't be sourced yet, the page shows an honest
  cold-start state, not a guess.
- **Backfilled curves are labeled.** Star history is reconstructed from GitHub and
  marked as such.
- **Private work stays private.** Public repos are committed to `data/`; private
  repos are captured only to a git-ignored `data/.local/` (enforced by a guard
  test) and surface on the public page as name + status only — no metrics.

## Tech

Next.js 16 (App Router, static export) · React 19 · TypeScript (strict) ·
Tailwind CSS v4 · hand-rolled `d3-shape` + `motion` charts behind a single barrel ·
GitHub Actions (capture + deploy) · GitHub Pages.

## Local development

```bash
pnpm install
pnpm dev          # http://localhost:3000 — reads data/*.ndjson
pnpm build        # CI chain (type-check · lint · test) + static export to out/
pnpm capture      # one local capture run (needs GH_PAT in the env)
pnpm test         # vitest
```

## Deploy (GitHub Pages) — no token to mint

1. **Settings → Pages → Source: GitHub Actions.**
2. For a *project* page (`…github.io/<repo>`), set repo **Actions variables**
   `NEXT_PUBLIC_BASE_PATH=/<repo>` and
   `NEXT_PUBLIC_SITE_URL=https://<you>.github.io/<repo>` (the latter makes shared
   links unfurl). Skip both for a custom domain or user page.
3. Push to `main`. The `site.yml` workflow builds + deploys; the daily run also
   captures fresh data and redeploys.

Keep the repo public so Actions stay free. **No PAT needed** — capture reads only
public data via the built-in Actions token. (A PAT would only be needed later to
capture *private* repos in CI for a hosted radar; the local radar uses your `gh` auth.)

## Layout

```
data/                 committed JSON store (public repos) + meta.json
  .local/             git-ignored — private-repo snapshots (local radar only)
scripts/capture.ts    daily capture → JSON
src/lib/store/        types · pure transforms · read bridge · view-model
src/lib/metrics/      pure derive layer (velocity, growth, aggregates)
src/components/charts/ d3-shape + motion chart primitives (barrel)
src/components/showcase/ the page sections
.github/workflows/    capture.yml (cron) · deploy.yml (Pages)
```

---

_Personal-first, architected to generalize. Built by Josh Gonzales._
