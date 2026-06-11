/**
 * JSON store contract — the static-first data model (v2 pivot, 2026-06-10).
 *
 * GitHub's API has no history, so capture (`scripts/capture.ts`, run daily by a
 * GitHub Action) persists a daily SNAPSHOT as one line in `data/<name>.ndjson`.
 * **Git history is the time-series log.** `derive.ts` (U8) maps these into its
 * pure `CumulativePoint` / `EventPoint` inputs — this file is the single source
 * of truth for the on-disk shape (the JSON analog of the old
 * `src/types/database.ts`, which the pivot removes).
 *
 * PRIVACY: public repos write to `data/<name>.ndjson` (committed); private repos
 * write to `data/.local/<name>.ndjson` (gitignored). Private-repo metrics must
 * NEVER enter committed JSON (CLAUDE.md privacy boundary; GS-010 guard).
 */

export type Visibility = 'public' | 'private'

/** One tracked repo (a row of `data/meta.json` `repos`). */
export interface TrackedRepo {
  /** Store key — the `data/<name>.ndjson` basename + the showcase slug. */
  name: string
  /** GitHub owner (org / user). */
  owner: string
  /** GitHub repo name (often, but not always, === `name`). */
  repo: string
  /** `public` → committed store; `private` → gitignored `data/.local/` (radar only). */
  visibility: Visibility
  /** Display label on the showcase (e.g. "arbiter.ac"). */
  displayName: string
  /** One-line description (Josh's voice / the GitHub description). */
  tagline: string
  /** Optional homepage / marketing link. */
  homepageUrl: string | null
  /** `YYYY-MM-DD` we began live snapshot tracking — the cold-start anchor. */
  trackingStartedAt: string
}

/** `data/meta.json` — the tracked roster + last successful capture stamp. */
export interface Meta {
  repos: TrackedRepo[]
  /** ISO timestamp of the last capture run, or null before the first. */
  lastCapture: string | null
}

/**
 * One daily snapshot — a line in `data/<name>.ndjson`. All counts are CUMULATIVE
 * running totals at `capturedAt` (downloads has no native history — `derive.ts`
 * diffs consecutive snapshots). Keyed by `d` (UTC day): a same-day re-run
 * overwrites that day's line (the JSON analog of `ON CONFLICT (repo, day)`).
 */
export interface Snapshot {
  /** `YYYY-MM-DD` UTC capture day (the upsert key). */
  d: string
  /** ISO-8601 capture timestamp. */
  capturedAt: string
  /** Cumulative downloads across all (non-draft) release assets. */
  downloads: number
  /** Stargazers count. */
  stars: number
  /** Forks count. */
  forks: number
  /** True watchers — `subscribers_count`, NOT `watchers_count` (KTD8). */
  watchers: number
  /** Cumulative downloads per release tag (the per-release bars). */
  releases: Record<string, number>
}

/**
 * `data/backfill/<name>.json` — reconstructable history that does NOT need daily
 * snapshots (R8): star events carry their own `starred_at`, releases their own
 * `published_at`. Regenerated in full each capture (cheap — derived from the full
 * GitHub history every run). Carries the early growth curve during cold-start.
 */
export interface Backfill {
  /** ISO timestamp this backfill was regenerated. */
  generatedAt: string
  /** Star events (`EventPoint`) — `at` is `starred_at`. Marks the curve reconstructed. */
  stars: Array<{ at: string }>
  /** Ship-cadence — each non-draft release's tag + `published_at`. */
  cadence: Array<{ tag: string; publishedAt: string }>
}
