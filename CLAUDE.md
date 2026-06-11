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
- **Capture:** daily **GitHub Action** → `scripts/capture.mjs` (reuses the U3 GitHub
  client) → append `data/<repo>.ndjson` → commit.
- **Charts (U9):** hand-rolled `d3-shape` + `motion` + SVG behind a barrel (KTD4),
  rendered client-side from the JSON.
- **Hosting:** GitHub Pages (static), deployed by `.github/workflows/deploy.yml`.
- **Error tracking (optional):** Sentry client-only; no-ops without a DSN.

---

## CI — runs in the deploy workflow (this repo is not on Vercel)

The monorepo default is Vercel-first CI; **Groundswell is the documented exception**
because it deploys to **GitHub Pages**, not Vercel.

- CI (type-check · lint · test) runs in `.github/workflows/deploy.yml` BEFORE
  `next build`, on every push. A red check blocks the Pages deploy.
- Daily capture (`capture.yml`) is the explicitly-allowed "scheduled automation
  Vercel can't do" exception (per `~/developer/CLAUDE.md`).
- **Keep the groundswell repo public** → Actions minutes are free/unlimited. (Private
  would be ~30–60 min/month, within the 2,000-min free tier — but public is the
  intended state for a recruiter showcase anyway.)
- `NODE_ENV=test` pinned on the test script (CI sets `production`, which strips React
  `act`). Local pre-commit via `simple-git-hooks` + `lint-staged`.
- Dependencies: Renovate (`renovate.json`), not Dependabot.

---

## Secret + privacy boundary

- **One secret: the GitHub PAT (`GH_PAT`).** It lives ONLY as a GitHub Actions repo
  secret, used by `scripts/capture.mjs` inside the Action. It is NEVER bundled into
  the static site — the deployed Pages site ships only the already-captured JSON: no
  tokens, no runtime secrets.
- **Public store = public repos only.** Capture commits metrics for PUBLIC repos to
  `data/`. Private-repo traction (provenance, arbiter.ac, marginalia) must NEVER land
  in committed JSON — it goes to gitignored `data/.local/`, read only by the local
  radar. **Leaking private-repo numbers in a public repo is the one unacceptable
  failure here** (enforced by a guard test — GS-010).
- **Least-privilege PAT:** fine-grained, `Administration:Read` + `Contents:Read` +
  `Metadata:Read`, scoped to the tracked repos, 90-day expiry + rotation reminder.
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

## Structure (target — v2 static-first)

```
groundswell/
├── package.json · renovate.json · pnpm-workspace.yaml · tsconfig.json
├── next.config.ts            # output: 'export' (static) · basePath for project Pages
├── postcss.config.mjs · eslint.config.mjs · vitest.config.ts
├── scripts/
│   ├── capture.mjs           # daily — GitHub API → append data/<repo>.ndjson
│   └── backfill.mjs          # one-time — starred_at + release dates → data/backfill/
├── .github/workflows/
│   ├── capture.yml           # cron (daily) → run capture → commit JSON
│   └── deploy.yml            # on push → CI (type-check·lint·test) → next build → Pages
├── data/
│   ├── meta.json             # repos · visibility · trackingStartedAt · lastCapture
│   ├── <repo>.ndjson         # daily snapshots (per-release counts inline) = history
│   ├── backfill/<repo>.json
│   └── .local/               # gitignored — private-repo metrics for the local radar
└── src/
    ├── app/                  # layout · page · globals.css (static showcase)
    ├── lib/
    │   ├── github/           # U3 client (reused by scripts/capture.mjs)
    │   └── metrics/derive.ts # reads data/*.ndjson → SSG figures
    └── components/charts/    # d3-shape + motion + SVG barrel (U9)
```

> The Supabase/Vercel scaffold (`src/lib/supabase/`, `supabase/migrations/`,
> `src/app/api/cron/`, `proxy.ts`, `vercel.json`, `@supabase/*`) is being removed in
> the pivot — see **GS-009**. Git history preserves it if ever needed.

---

## Development

```bash
pnpm install
pnpm dev            # localhost:3000 — reads data/*.ndjson (+ data/.local for radar)
pnpm build          # CI chain + static export (next build, output: 'export')
pnpm capture        # node scripts/capture.mjs — local capture (needs GH_PAT in env)
pnpm test           # vitest (NODE_ENV=test)
```

Live capture requires GS-001 ops (Josh): mint the fine-grained PAT → repo secret
`GH_PAT`; enable GitHub Pages (Source: GitHub Actions); set the tracked repos in
`data/meta.json`. Keep the repo public so Actions stay free.

---

*Inherits the Opus Vita Dual Standard (Apple-grade design + enterprise SaaS) and the
workspace design protocols. CI/host deviate from Vercel-first by design (static Pages
deploy) — documented above. See `~/developer/CLAUDE.md`.*
