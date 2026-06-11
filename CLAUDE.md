# Groundswell

> **Developer-traction showcase.**
> A daily GitHub Action captures multi-signal adoption → JSON in this repo →
> a static GitHub Pages site, led by growth + an honest absolute aggregate.
> Plus a local-only "what's growing" radar.

---

## What it is

Personal-first developer-traction showcase. A daily **GitHub Action** captures
multi-signal adoption (downloads, stars, forks, watchers, ship-cadence) and commits
it as JSON to this repo — **git history is the time-series store**. A static
**GitHub Pages** site reads that JSON: a public showcase leads with a real absolute
aggregate (total downloads + stars), momentum as the supporting modifier, and
backfilled curves (stars / forks / ship-cadence) carrying the early growth story
during cold-start. A private "what's growing" radar runs **local-only** (`pnpm dev`)
— static hosting can't gate it server-side.

**No Supabase, no Vercel** (architecture chosen 2026-06-10 — see `PLAN.md`). GitHub's
API has no history, so the only hard requirement is persisting a daily snapshot;
JSON-in-repo does that at personal scale without a database.

**Plan (read first):** `PLAN.md` (v2: static-first). Origin brainstorm +
v1 (Supabase) plan are archived under `docs/`. Current state: `STATUS.md`.
Open issues: `ISSUES.md`.

---

## Product invariants (never violate)

Load-bearing. U9/U10 and every later surface inherit them.

1. **No hardcoded numbers — ever.** Every figure the UI shows (downloads, stars,
   per-release bars, deltas, dates) renders from the JSON store via the derive layer
   (`src/lib/metrics/derive.ts`) — never a literal in JSX, never a committed fixture
   passed off as live. If a number can't be sourced yet, show an honest empty /
   cold-start state, not a guess.
2. **Honesty-first.** No traction claimed before it's earned. Cold-start curves are
   labeled ("tracking started &lt;month&gt;"); backfilled series (stars / forks / cadence)
   are marked reconstructed; private/unreleased repos show status, not invented metrics.
3. **De-echo.** Each figure appears exactly once in visible copy — no restating the
   same number across hero + caption + tooltip.
4. **Canonical visual source of truth:** `docs/mockups/2026-06-10-showcase-real.html`
   (design gate approved 2026-06-10). U10 ports it to the pixel — real numbers,
   full-width, quiet "Shipping next", aligned. Don't re-derive the design.

---

## Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript 5.8 (strict),
  **static export** (`output: 'export'`) — no server at runtime.
- **Styling:** Tailwind CSS v4 (`@import "tailwindcss" source(none)` + `@source "./src"`).
  Design tokens land in `globals.css` (`@theme`) when U10 ports the approved mockup.
- **Store:** JSON in `data/` (NDJSON daily snapshots). **Git history is the
  time-series log.** No database.
- **Capture:** daily **GitHub Action** → `scripts/capture.ts` (reuses the U3 GitHub
  client) → append `data/<repo>.ndjson` → commit.
- **Charts (U9):** hand-rolled `d3-shape` + `motion` + SVG behind a barrel (KTD4),
  rendered client-side from the JSON.
- **Hosting:** GitHub Pages (static), built + deployed by `.github/workflows/site.yml`
  (one workflow: push → build + deploy; daily cron → capture + commit + build + deploy).

---

## CI — runs in the site workflow (this repo is not on Vercel)

The monorepo default is Vercel-first CI; **Groundswell is the documented exception**
because it deploys to **GitHub Pages**, not Vercel.

- CI (type-check · lint · test) runs in `.github/workflows/site.yml` BEFORE
  `next build`. A red check blocks the Pages deploy.
- The daily capture in that same workflow is the explicitly-allowed "scheduled
  automation Vercel can't do" exception (per `~/developer/CLAUDE.md`).
- **Keep the groundswell repo public** → Actions minutes are free/unlimited. (Private
  would be ~30–60 min/month, within the 2,000-min free tier — but public is the
  intended state for a recruiter showcase anyway.)
- `NODE_ENV=test` pinned on the test script (CI sets `production`, which strips React
  `act`). Local pre-commit via `simple-git-hooks` + `lint-staged`.
- Dependencies: Renovate (`renovate.json`), not Dependabot.

---

## Secret + privacy boundary

- **No secret needed to deploy.** CI capture reads only PUBLIC data, so the built-in
  Actions `GITHUB_TOKEN` suffices — no PAT to mint. Nothing is bundled into the static
  site; it ships only the already-captured JSON (no tokens, no runtime secrets).
- **Public store = public repos only.** Capture commits metrics for PUBLIC repos to
  `data/`. Private-repo traction (provenance, arbiter.ac, marginalia) must NEVER land
  in committed JSON — it goes to gitignored `data/.local/`, read only by the local
  radar. **Leaking private-repo numbers in a public repo is the one unacceptable
  failure here** (enforced by `src/lib/store/privacy.test.ts` — GS-010).
- **A PAT is local/private-only.** To capture private repos for the local radar, use
  your machine's `gh auth token`. A minted fine-grained PAT (`Administration:Read` +
  `Contents:Read` + `Metadata:Read`, scoped) is only needed if you ever capture
  private repos in CI; never commit it.
- **No service-role / no DB / no auth surface.** The static site has no server — no
  admin client, no RLS, no session middleware to get wrong.

---

## GitHub data-model gotchas (capture + derive + UI must respect)

Hard-won; getting any of these wrong silently corrupts the curves.

- **`watchers` = `subscribers_count`, NOT `watchers_count`.** GitHub's `watchers_count`
  is an alias of stargazers. Use `subscribers_count` for true watchers.
- **Release `download_count` is cumulative, no history.** A running per-asset total;
  deltas come from differencing our daily snapshots, never from the API.
- **Traffic (views/clones) is owner-only + 14-day rolling.** Re-capture the full
  14-day window each run and dedupe by `(repo, metric, day)` so late-arriving days
  self-heal (in JSON: rewrite the trailing 14 days, don't blind-append).
- **Daily uniques are NOT additive.** Summing daily `uniques` overcounts — persist the
  window-level unique figure; never sum.
- **Stars / forks / cadence are backfillable** (`star+json` `starred_at`; creation /
  published timestamps). The cold-start story rides these reconstructed series.

---

## Mockup-first

Any user-facing UI surface goes through a ranked HTML mockup + owner approval
**before** implementation. The showcase mockup (**U5**) was approved 2026-06-10
(`docs/mockups/2026-06-10-showcase-real.html`). Recruiter validation (**U6**) was
waived by Josh ("assume recruiter thinks it's fine"). `src/app/page.tsx` is a
deliberate placeholder until U10 ports the mockup to components.

---

## Design conventions (U9 / U10)

Carry these from the approved mockup into real components.

- **Full-width, no left-hug.** Sections use the full content measure; headings and
  intros stretch across, not a narrow left column. (Josh's repeated note.)
- **Section spacing in longhand** — `padding-top` / `padding-bottom` on gutter
  containers, never `padding: <v> 0` (it zeroes the horizontal gutter and breaks
  alignment). Every section shares one x-gutter.
- **Single-renderer charts (KTD4):** `d3-shape` + `motion` + SVG behind a barrel — one
  renderer, not a chart-lib zoo. **Stat numbers are HTML** (SVG `<text>` fails AA/zoom
  + JPEG washout); **tooltips render via a portal**, not inside the SVG.
- **Quiet the unearned.** Live earned traction (citegeist) gets the loud treatment;
  private / in-progress repos get calm secondary cards — name-led, muted status, no
  invented color. Restraint reads as honesty.
- **Honesty cues are design elements**, not afterthoughts: cold-start labels,
  "reconstructed" tags on backfilled series, AA contrast on every honesty note.

---

## Structure (v2 static-first — as built)

```
groundswell/
├── package.json · renovate.json · pnpm-workspace.yaml · tsconfig.json
├── next.config.ts            # output: 'export' (static) · basePath for project Pages
├── postcss.config.mjs · eslint.config.mjs · vitest.config.ts
├── scripts/
│   └── capture.ts            # daily — GitHub API → data/<repo>.ndjson + backfill + meta
├── .github/workflows/
│   └── site.yml              # push→build+deploy; daily cron→capture+commit+build+deploy
├── data/
│   ├── meta.json             # repos · visibility · trackingStartedAt · lastCapture
│   ├── <repo>.ndjson         # daily snapshots (per-release counts inline) = history
│   ├── backfill/<repo>.json
│   └── .local/               # gitignored — private-repo metrics for the local radar
└── src/
    ├── app/                  # layout · page · globals.css (static showcase)
    ├── lib/
    │   ├── github/           # U3 client (reused by scripts/capture.ts)
    │   └── metrics/derive.ts # reads data/*.ndjson → SSG figures
    └── components/charts/    # d3-shape + motion + SVG barrel (U9)
```

> The v1 Supabase/Vercel/Sentry scaffold was removed in **GS-009** (commit
> `fe76c78`, 2026-06-11); git history preserves it if ever needed.

---

## Development

```bash
pnpm install
pnpm dev            # localhost:3000 — reads data/*.ndjson (+ data/.local for radar)
pnpm build          # CI chain + static export (next build, output: 'export')
pnpm capture        # tsx scripts/capture.ts — local capture (GH_PAT or `gh auth token`)
pnpm test           # vitest (NODE_ENV=test)
```

Live deploy requires GS-001 ops (Josh, **no PAT**): enable GitHub Pages (Source:
GitHub Actions); for a project page set the Pages vars `NEXT_PUBLIC_BASE_PATH` +
`NEXT_PUBLIC_SITE_URL`; push + merge to main. Keep the repo public so Actions stay free.

---

*Inherits the Opus Vita Dual Standard (Apple-grade design + enterprise SaaS) and the
workspace design protocols. CI/host deviate from Vercel-first by design (static Pages
deploy) — documented above. See `~/developer/CLAUDE.md`.*
