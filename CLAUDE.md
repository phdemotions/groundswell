# Groundswell

> **Developer-traction showcase.**
> Capture multi-signal GitHub adoption over time → a recruiter-facing public page
> led by growth + an honest absolute aggregate, plus a private "what's growing" radar.

---

## What it is

Personal-first developer-traction showcase. One capture spine writes a
source-agnostic snapshot store (GitHub v1: downloads, stars, forks, watchers,
views, clones, referrers, ship-cadence); everything reads derived views off it.
A public unauthenticated showcase leads with a real absolute aggregate (total
downloads + stars) with momentum as the supporting modifier, and backfilled
curves (stars/forks/ship-cadence) carry the early growth story during cold-start.
A private, auth-gated radar ranks what's growing.

**Canonical plan (read first):**
[`docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md`](docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md)
Brainstorm: `docs/brainstorms/2026-06-10-developer-traction-showcase-requirements.md`.
Current state: `STATUS.md`. Open issues: `ISSUES.md`.

---

## Product invariants (never violate)

Load-bearing. U9/U10 and every later surface inherit them.

1. **No hardcoded numbers — ever.** Every figure the UI shows (downloads, stars,
   per-release bars, deltas, dates) renders from the capture pipeline via the U8
   derived views — never a literal in JSX, never a prod fixture. If a number can't be
   sourced yet, show an honest empty / cold-start state, not a guess.
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

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript 5.8 (strict)
- **Styling:** Tailwind CSS v4 (`@import "tailwindcss" source(none)` + `@source "./src"`).
  Design tokens are owned by **U5** — do NOT add an `@theme` block to
  `src/app/globals.css` before the U5 mockup approval gate.
- **Database:** Supabase — own dedicated project (`public` schema), not a shared instance (KTD11)
- **Auth:** Supabase Auth (`@supabase/ssr`) — public showcase is anon; radar + curation are gated
- **Error tracking:** Sentry (`@sentry/nextjs`) — consent-gated, no-ops without a DSN, PII stripped
- **Charts (later, U9):** hand-rolled `d3-shape` + `motion` + SVG behind a barrel (KTD4)
- **Deployment:** Vercel (Pro plan); daily capture via Vercel Cron (needs Fluid Compute)

---

## CI Policy — Vercel-first, NOT GitHub Actions

**Rule:** all CI checks (type-check, lint, tests, build) run inside the
`pnpm build` chain so Vercel runs them on every preview + production deploy.
Josh has Vercel Pro (build minutes included); GitHub Actions minutes bill against
his personal plan. (KTD9 · mirrors `~/developer/allages`.)

- `package.json` `"build"`: `pnpm run type-check && pnpm run lint && pnpm run test && next build`
- `vercel.json` `buildCommand: "pnpm run build"` (explicit — prevents Next auto-detect bypass)
- `build:next` is the emergency escape hatch (`next build` only)
- `NODE_ENV=test` is pinned on the test script (Vercel sets `NODE_ENV=production`,
  which strips React `act` and breaks the test env)
- Local pre-commit via `simple-git-hooks` + `lint-staged` (free, fast feedback)

**Do not add `.github/workflows/*.yml` for type-check / lint / test / build.**
Add to the build chain instead. (GH Actions OK only for non-deploy automation
Vercel can't do — scheduled DB cleanups, cross-repo — with explicit approval.)

**Dependencies:** Renovate (`renovate.json`), not Dependabot — runs as a GitHub
App, no Actions billing, Vercel-preview-gated auto-merge.

---

## Secret + trust boundary (KTD10)

- **Service-role key is server-only.** `src/lib/supabase/admin.ts` imports the
  `server-only` package (build fails if bundled client-side). Two more guards:
  an eslint `no-restricted-imports` rule barring `admin` from the `(public)`
  route group, and `__tests__/admin-import-barrier.test.ts` (scans every
  `'use client'` file). Never weaken any of the three.
- **Three Supabase clients, never mixed:** `client.ts` (browser, anon, RLS),
  `server.ts` (Server Components/Actions, anon, RLS), `admin.ts` (service-role,
  RLS bypass, server-only). The capture path is the only routine admin consumer.
- **RLS is deny-all by default; the public showcase reads one read-only view**
  (derived / aggregate columns only — never raw internal rows). The anon role gets
  `SELECT` on that view and nothing else.
- **`CAPTURE_ENABLED` defaults OFF.** `src/lib/env.ts` (Zod) only *requires*
  `GITHUB_TOKEN` + `CRON_SECRET` (min length) when capture is on, so dev/preview
  boot without them. Server vars never carry a `NEXT_PUBLIC_` prefix.
- **Next 16 uses `proxy.ts` / `proxy()`**, NOT `middleware.ts` (which Next 16
  ignores — the auth gate would silently not run). The session-refresh helper is
  `src/lib/supabase/middleware.ts`, imported by the root `proxy.ts`.

---

## GitHub data-model gotchas (capture + derive + UI must respect)

Hard-won; getting any of these wrong silently corrupts the curves.

- **`watchers` = `subscribers_count`, NOT `watchers_count`.** GitHub's `watchers_count`
  is an alias of stargazers. Use `subscribers_count` for true watchers.
- **Release `download_count` is cumulative, no history.** A running per-asset total;
  deltas come from differencing our daily snapshots, never from the API.
- **Traffic (views/clones) is owner-only + 14-day rolling.** Re-upsert the full 14-day
  window each run (`ON CONFLICT (repo, metric, day)`) so late-arriving days self-heal.
- **Daily uniques are NOT additive.** Summing daily `uniques` overcounts — persist the
  window-level unique figure; never sum.
- **Stars / forks / cadence are backfillable** (`star+json` `starred_at`; creation /
  published timestamps). The cold-start story rides these reconstructed series.
- **Least-privilege PAT:** fine-grained, `Administration:Read` + `Contents:Read` +
  `Metadata:Read`, scoped to tracked repos, 90-day expiry + rotation.

---

## Mockup-first

This product follows the monorepo **mockup-first** rule: any user-facing UI
surface goes through a ranked HTML mockup + owner approval **before**
implementation. The design system + showcase mockups are **U5** (an explicit
approval gate); recruiter validation against that mockup is **U6**, and it gates
the heavy Phase C build. The current `src/app/page.tsx` is a deliberate
placeholder carrying no design debt.

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
- **Tokens come from U5.** Once the design system lands in `globals.css` (`@theme`),
  components consume tokens — no ad-hoc hex or spacing.

---

## Structure (current — scaffold)

```
groundswell/
├── package.json · vercel.json · renovate.json · pnpm-workspace.yaml · tsconfig.json
├── next.config.ts · postcss.config.mjs · eslint.config.mjs · vitest.config.ts
├── proxy.ts                         # Next 16 session refresh (NOT middleware.ts)
├── instrumentation.ts · sentry.{client,server}.config.ts
├── vitest.setup.ts · vitest.server-only-shim.ts
├── __tests__/                       # env-schema + admin-import-barrier smoke tests
└── src/
    ├── app/                         # layout · page (placeholder) · globals.css
    ├── lib/
    │   ├── env.ts                   # Zod, capture-gated secret requirements
    │   └── supabase/{client,server,admin,middleware}.ts
    └── types/database.ts            # placeholder — U2 generates the real type
```

Future layout (per plan): `src/app/(public)/` showcase · `src/app/(app)/` radar +
curation · `src/app/api/cron/github-capture/route.ts` · `supabase/migrations/` ·
`src/components/charts/` (barrel) · `scripts/backfill.ts`.

---

## Development

```bash
pnpm install
pnpm dev          # localhost:3000
pnpm build        # full CI chain: type-check → lint → test → next build
pnpm test         # vitest (NODE_ENV=test)
```

Live capture requires U0 ops (GS-001): dedicated Supabase project, fine-grained
PAT, secrets in all three Vercel buckets, Fluid Compute. Until then the app runs
with `CAPTURE_ENABLED=false`.

---

*Inherits the Opus Vita Dual Standard (Apple-grade design + enterprise SaaS) and
the workspace CI / dependency / design protocols. See `~/developer/CLAUDE.md`.*
