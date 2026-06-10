---
date: 2026-06-10
topic: developer-traction-showcase
title: "Groundswell — Developer Traction Showcase"
---

# Groundswell — Developer Traction Showcase

## Summary

Groundswell is a personal developer-traction showcase. It captures multiple adoption signals (downloads, repo views, stars, clones, ship-cadence) across a developer's projects over time, then presents them two ways: a public, recruiter-credible page that leads with growth and velocity so modest counts read as momentum, and a private radar that surfaces which projects are gaining traction. Built for the owner's repos first, architected to open to other developers later. Lives in its own git repo at `groundswell/`.

---

## Problem Frame

A prolific builder with many real, shipped, adopted projects has no good way to *show* that to a recruiter. Each individual project has modest numbers — hundreds of downloads, not tens of thousands — so any single metric reads as weak. GitHub's native surfaces make it worse: the releases page shows a flat cumulative count, the traffic tab shows only the last 14 days and then discards it.

Two things compound the loss. GitHub release `download_count` is a cumulative integer with **no history** — you know how many, never when. Repo views and clones, arguably the *strongest* "people care about my work" signal, exist only in a **14-day rolling, owner-only window** and are gone after that. Every day not captured is data destroyed.

The recruiter looking at this is often non-technical and spends seconds. The compelling story isn't any one number — it's the aggregate (breadth × adoption), the momentum (growth over time), and the craft of the presentation itself. None of that is reconstructable after the fact, which makes *starting to capture* the urgent move, separate from building anything a viewer sees.

The same captured history answers a second, private question the owner has: which of my projects is actually growing, so I know where to invest. That question is a derivative — it cannot be answered from a single snapshot — so it forces the same time-series spine.

---

## Key Decisions

- **Velocity over absolute totals.** Lead presentation with growth and rate-of-change. Hundreds of downloads impress as "+40% this week"; they fall flat as a static "200." This is the core reframe that makes modest real numbers credible to a recruiter.

- **Multi-signal aggregate over downloads-only.** Downloads alone is the weakest version. The product's value is the roll-up across many signals and many projects. The richest signals (repo views/clones) are ones most tools ignore because they're perishable.

- **One source-agnostic snapshot spine, two surfaces.** A single capture layer records every signal over time and feeds both the public showcase and the private radar. Both jobs are real; serving both costs one extra view, not a second system.

- **Capture-first sequencing.** Snapshotting runs and persists before any UI exists. Release downloads have no history and traffic views/clones expire in 14 days; this data is unbackfillable, so capture is the first thing built and the thing that must never lapse.

- **Personal-first, owner-only signals embraced, architected to generalize.** The data-richest case is the owner's own repos, because views/clones/referrers need the owner's token. v1 leans into that. The model and surfaces are structured so opening to public self-serve is additive, accepting that owner-only signals degrade for repos the user doesn't control.

- **Curated, not auto-discovered.** The owner hand-picks which projects and signals appear. A recruiter showcase needs editorial control — dead or embarrassing repos stay hidden. Capture can be broad; publishing is selective.

- **Mockup-first.** Every UI primitive and screen is mocked up and owner-approved before it is implemented. The bar is award-winning beauty and hiring-manager appeal; visuals are gated on the owner's eye, not inferred from code. Design and capture proceed in parallel — capture (headless) doesn't wait on visual sign-off, but no surface gets built before its mockup is approved.

---

## Actors

- A1. **Project owner** — the developer (Josh). Maintains the tracked-project list, controls public visibility per project/signal, reads the private radar. Provides the authorized access that unlocks owner-only signals.
- A2. **External viewer** — a recruiter or hiring manager. Reads the public showcase via a shared link. Often non-technical, low time budget.
- A3. **Capture process** — a scheduled, headless job. Pulls each signal from its source on a cadence and writes timestamped snapshots. Runs independent of any UI.
- A4. **Signal sources** — external systems holding the raw metrics. GitHub in v1; npm, Obsidian, and other registries accommodated later.

---

## Signal Catalog

The organizing axis is **data perishability** — it decides what must be captured now versus reconstructed later.

| Signal | Source | Data shape | Class | Recruiter read |
|---|---|---|---|---|
| Release downloads | GitHub | cumulative integer, no history | 🔴 perishable | adoption of shipped builds |
| Repo views (unique + total) | GitHub traffic | owner-only, 14-day rolling | 🔴 perishable | "people are looking at my work" (strongest) |
| Clones | GitHub traffic | owner-only, 14-day rolling | 🔴 perishable | "devs are pulling my code" |
| Referrer sources | GitHub traffic | owner-only, 14-day rolling | 🔴 perishable | where attention originates |
| Watchers | GitHub | cumulative, weak history | 🔴 perishable | sustained interest |
| Obsidian installs | Obsidian registry | cumulative | 🔴 perishable (later) | shipped, adopted plugin |
| Stars over time | GitHub stargazers | timestamped event log | 🟢 backfillable | social-proof curve |
| Forks | GitHub | per-fork `created_at` | 🟢 backfillable | derivation interest |
| npm downloads | npm | full daily time-series | 🟢 backfillable (later) | free growth curve |
| Ship cadence / recency | GitHub commits + releases | full history | 🟢 backfillable | "actively shipping" momentum |

🧮 **Computed across all signals:** velocity (Δ per period), growth rate (%), aggregate cross-project totals, momentum/recency, all-time peak.

---

## Requirements

**Capture spine**

- R1. A scheduled process records a timestamped snapshot of every tracked signal for every tracked project on a recurring cadence, independent of any UI.
- R2. Capture runs and persists from day one, before showcase or radar UI exists, so perishable signals accrue history that cannot be backfilled.
- R3. The snapshot model is source-agnostic: adding a new source or metric extends the model without reshaping it.
- R4. Capture is safe to re-run; a missed run leaves a gap in the series but never corrupts existing history.
- R5. Each signal records its data-availability class (cumulative-only, native-time-series, or rolling-window) so derived math treats each correctly.

**Signals tracked (v1: GitHub, owner repos)**

- R6. v1 captures, per tracked repo: release-asset downloads, stars, forks, watchers, repo views (unique + total), clones, referrer sources, and ship-cadence (commit + release recency and frequency).
- R7. Owner-only signals (views, clones, referrers) are captured via the owner's authorized access and flagged owner-only; they are understood not to exist for repos the owner doesn't control.
- R8. Backfillable signals are reconstructed from source history on first capture where the source provides it (stars from stargazer timestamps, forks from per-fork creation dates); cumulative-only signals start from the capture date.
- R9. Non-GitHub sources (npm, Obsidian, VS Code Marketplace, PyPI, Homebrew, crates.io, Docker Hub) are accommodated by the model but not wired in v1.

**Derived metrics**

- R10. For every signal, the system computes velocity (change per period) and growth rate (%) over selectable windows.
- R11. The system computes aggregate cross-project totals per signal and an overall traction roll-up across all tracked projects.
- R12. Derived metrics degrade gracefully when fewer than two snapshots exist: show the absolute value plus a "tracking started" marker, never a false 0% or an error.

**Public showcase (recruiter surface — ships first)**

- R13. A public, shareable page presents the aggregate traction story, designed to read as credible to a non-technical viewer within roughly three seconds.
- R14. The showcase foregrounds momentum framing (e.g., "+40% this week", "1,200 views this month") ahead of raw absolute totals.
- R15. A secondary view tells one project's full story in depth — the "killer project" (citegeist first).
- R16. The showcase is curated: the owner selects which projects and which signals appear; nothing is auto-published.
- R17. The page is linkable from a resume or portfolio and exportable as a static image for slides and social.

**Private radar (owner surface — fast-follow)**

- R18. A private view ranks tracked projects by growth and velocity so the owner can see which are gaining traction and where to invest.
- R19. The radar surfaces per-project and per-signal trends over time, including perishable signals the public showcase doesn't emphasize.

**Curation & visibility**

- R20. The owner maintains the tracked-project list explicitly (add and remove); the system does not auto-discover repos.
- R21. Public visibility is controlled per project and per signal, independently of capture — capture broadly, publish selectively.

**Design quality**

- R22. Presentation meets the dual standard (award-grade design plus enterprise polish); the visual craft is itself a traction signal to recruiters.
- R23. The showcase renders small-magnitude data so it looks intentional and credible — modest numbers must never appear sparse or embarrassing.
- R24. Every UI primitive and screen is delivered as an owner-approved mockup before implementation. The approval bar is award-winning beauty and demonstrable hiring-manager appeal; a primitive that hasn't passed a mockup gate is not built.

**Architected to generalize**

- R25. v1 is personal, but the data model and surfaces are structured so opening to public self-serve (any developer, any repo) is an additive step rather than a rewrite, accepting that owner-only signals degrade for non-owned repos.

---

## Key Flows

- F1. **Capture cycle**
  - **Trigger:** scheduled cadence fires.
  - **Actors:** A3, A4
  - **Steps:** For each tracked project, pull each configured signal from its source; write a timestamped snapshot for each; record the data-availability class.
  - **Outcome:** the time series grows by one point per signal; perishable data is preserved before it expires.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R7, R8

- F2. **Public showcase view**
  - **Trigger:** an external viewer opens the shared link.
  - **Actors:** A2
  - **Steps:** Load curated projects and signals; compute velocity, growth, and aggregate roll-up; render momentum-led with the strongest aggregate up top.
  - **Outcome:** the viewer concludes "this person ships real, growing software" within seconds.
  - **Covered by:** R10, R11, R12, R13, R14, R15, R16, R23

- F3. **Radar view**
  - **Trigger:** the owner opens the private view.
  - **Actors:** A1
  - **Steps:** Rank tracked projects by velocity across all captured signals, including perishable ones; show per-project and per-signal trend.
  - **Outcome:** the owner sees what's growing and where to invest.
  - **Covered by:** R10, R18, R19

- F4. **Curation**
  - **Trigger:** the owner adds or removes a project, or changes visibility.
  - **Actors:** A1
  - **Steps:** Update the tracked list; capture begins for new projects on the next cycle; set per-project/per-signal public visibility.
  - **Outcome:** the showcase reflects only what the owner chose to publish.
  - **Covered by:** R16, R20, R21

---

## Acceptance Examples

- AE1. **Covers R12.**
  - **Given:** a project tracked for one day (a single snapshot).
  - **When:** the showcase and radar render it.
  - **Then:** they show the absolute value and "tracking started 2026-06-10" — not "0% growth" and not an error.

- AE2. **Covers R2, R6, R7.**
  - **Given:** capture has been running daily on an owned repo.
  - **When:** capture lapses for more than 14 days, then resumes.
  - **Then:** views/clones for the lapsed window are permanently absent (a visible gap), while cumulative signals resume without corruption — demonstrating why capture must not lapse.

- AE3. **Covers R14, R23.**
  - **Given:** a project with ~200 lifetime downloads but recent upward movement.
  - **When:** it appears on the public showcase.
  - **Then:** it leads with momentum ("+18% this month") and contributes to the aggregate roll-up, rather than displaying a lonely "200."

- AE4. **Covers R8.**
  - **Given:** a repo added to tracking for the first time.
  - **When:** the first capture runs.
  - **Then:** star history is backfilled from stargazer timestamps, while download history begins at the capture date (no backfill possible).

---

## Success Criteria

- **Three-second recruiter test:** a non-technical viewer concludes "this person ships real, adopted, growing software" within roughly three seconds of opening the showcase.
- **Capture reliability:** under normal operation there are no gaps in perishable signals; a missed run is recoverable without corrupting the series.
- **Modest-number credibility:** small magnitudes render as intentional and momentum-framed, never sparse.
- **Design bar:** passes the dual standard (award-grade + enterprise polish) on visual verification.
- **Design approval gate:** every UI primitive and screen is signed off by the owner from a mockup before implementation; nothing reaches code unreviewed visually.
- **Handoff quality:** `ce-plan` can produce an implementation plan from this doc without inventing product behavior, scope, or success criteria.

---

## Scope Boundaries

**Deferred for later**

- Public self-serve mode (any developer enters any repo and gets their showcase).
- Embeddable, auto-updating README badges/cards.
- Non-GitHub sources: npm, Obsidian, VS Code Marketplace, PyPI, Homebrew, crates.io, Docker Hub — designed-for in the model, not wired in v1.
- Multi-user accounts and authentication beyond what one private radar needs.

**Outside this product's identity**

- Social-media mention tracking (Twitter/X, blogs) — too noisy to be credible traction.
- Vanity comparison against other people's repos — that's star-history's job, not this product's.
- Real-time / live dashboards — a daily-ish capture cadence is sufficient; live data adds cost without changing the recruiter or radar story.

---

## Dependencies / Assumptions

- **GitHub API access** with an owner token whose scopes include repo traffic. Views, clones, and referrers require push access — they are unavailable without owner-level authorization.
- **GitHub traffic API** returns a 14-day rolling window only and is owner-only. Load-bearing constraint behind capture-first sequencing.
- **GitHub release `download_count`** is cumulative with no time-series. Download history exists only from the capture date forward.
- **Rate limits:** capture across N repos and M signals must stay within GitHub API limits; cadence and batching are constrained by this.
- **Backfill sources:** stars reconstructable from stargazer timestamps; npm daily downloads available when that source is wired.
- **Single user (owner)** in v1; only owner-published data appears on the public showcase.
- **Licensing:** the original github-release-stats is GPL-3.0. Groundswell is built fresh using it only as a reference for GitHub-API plumbing; copying its source would bind Groundswell to GPL-3.0, so a clean-room build keeps licensing open.

---

## Outstanding Questions

**Deferred to Planning**

- Capture cadence (daily vs. more frequent for the 14-day traffic window) and the batching strategy that stays within GitHub rate limits.
- How the private radar is gated (lightweight auth vs. local-only vs. obscure URL).
- The static-image export mechanism for the showcase.
- Default derived-metric windows (weekly, monthly) and how windows are selected.
- The exact v1 tracked-repo set (citegeist confirmed first; owner to enumerate the rest).
- Where the public showcase is hosted and how it's deployed.

---

## Sources / Research

- GitHub release `download_count` is cumulative with no time-series — [George Mandis](https://george.mand.is/2026/05/tracking-homebrew-downloads-with-githubs-api/), [Thore Göbel](https://thore.io/posts/2025/04/getting-the-download-count-of-github-release-assets/).
- GitHub traffic (views/clones/referrers): 14-day rolling window, requires push access — [GitHub REST docs: repository metrics/traffic](https://docs.github.com/en/rest/metrics/traffic).
- Star history reconstructed from stargazer timestamps — [star-history.com](https://www.star-history.com/).
- Landscape gap: [github-readme-stats](https://github.com/anuraghazra/github-readme-stats) owns README cards, [shields.io](https://shields.io) owns badges, star-history owns star curves — none own a beautiful multi-signal traction showcase for a portfolio.
- Reference implementation (GitHub-API plumbing only, GPL-3.0): [ghostbyte-dev/github-release-stats](https://github.com/ghostbyte-dev/github-release-stats) — Next.js + TypeScript + Tailwind, client-side.
