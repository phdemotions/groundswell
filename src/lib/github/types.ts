/**
 * GitHub REST API types — U3 (KTD5, KTD8).
 *
 * Two layers, deliberately separated:
 *
 *   - `Raw*` types mirror the wire shape but treat **every** field as optional /
 *     nullable. GitHub payloads evolve and individual fields can be absent for
 *     reasons outside our control (permissions, deprecation, partial objects).
 *     The client must degrade, never crash — so the raw layer never promises a
 *     field is present, and the parse layer null-guards + bounds-clamps each one.
 *
 *   - The parsed domain types (`RepoSummary`, `TrafficSeries`, …) are what the
 *     rest of Groundswell consumes: total, normalized, safe to render.
 *
 * Naming: `GitHub*` prefix per Opus Vita conventions (CONVENTIONS.md).
 *
 * @see https://docs.github.com/en/rest
 */

// ============================================================================
// Raw wire shapes (everything optional — payloads evolve, degrade never crash)
// ============================================================================

/** `GET /repos/{owner}/{repo}` — only the fields v1 reads. */
export interface RawRepo {
  stargazers_count?: number | null
  forks_count?: number | null
  /**
   * The count of users *watching* (subscribed to) the repo. KTD8: this is the
   * real watcher count. `watchers_count` is a GitHub alias for the star count
   * and must never be used for watchers.
   */
  subscribers_count?: number | null
  /** Alias for stargazers_count. Intentionally NOT used for watchers (KTD8). */
  watchers_count?: number | null
}

/** A single day's row in a traffic views/clones response. */
export interface RawTrafficDay {
  timestamp?: string | null
  count?: number | null
  uniques?: number | null
}

/** `GET /repos/{owner}/{repo}/traffic/views` (and `/clones`). */
export interface RawTrafficResponse {
  /** Window-level total over the 14-day window. */
  count?: number | null
  /** Window-level uniques — NON-ADDITIVE; not the sum of daily uniques (KTD1). */
  uniques?: number | null
  views?: RawTrafficDay[] | null
  clones?: RawTrafficDay[] | null
}

/** `GET /repos/{owner}/{repo}/traffic/popular/referrers` row. */
export interface RawReferrer {
  referrer?: string | null
  count?: number | null
  uniques?: number | null
}

/** A release asset within `GET /repos/{owner}/{repo}/releases`. */
export interface RawReleaseAsset {
  id?: number | null
  name?: string | null
  content_type?: string | null
  size?: number | null
  download_count?: number | null
  created_at?: string | null
  updated_at?: string | null
}

/** A release within `GET /repos/{owner}/{repo}/releases`. */
export interface RawRelease {
  id?: number | null
  tag_name?: string | null
  name?: string | null
  draft?: boolean | null
  prerelease?: boolean | null
  created_at?: string | null
  published_at?: string | null
  assets?: RawReleaseAsset[] | null
}

/**
 * `GET /repos/{owner}/{repo}/stargazers` with the `star+json` media type.
 * Without that media type GitHub returns bare user objects and `starred_at` is
 * absent — the parser surfaces null rather than fabricating a timestamp.
 */
export interface RawStargazer {
  starred_at?: string | null
  user?: { login?: string | null } | null
  /** Present on the plain (non-star+json) shape: the row IS the user. */
  login?: string | null
}

/** `GET /repos/{owner}/{repo}/forks` row. */
export interface RawFork {
  id?: number | null
  full_name?: string | null
  created_at?: string | null
}

/**
 * `GET /repos/{owner}/{repo}/commits` row (only the fields ship-cadence reads).
 * The authored/committed dates live under the nested `commit` object; the SHA is
 * the top-level `sha`. Everything is optional — the parser degrades to null.
 */
export interface RawCommit {
  sha?: string | null
  commit?: {
    author?: { date?: string | null } | null
    committer?: { date?: string | null } | null
  } | null
}

// ============================================================================
// Parsed domain types (total, normalized, safe to render)
// ============================================================================

/** Repo headline counts. `watchers` is always `subscribers_count` (KTD8). */
export interface RepoSummary {
  stars: number
  forks: number
  watchers: number
}

/** One normalized day of traffic. `day` is the `YYYY-MM-DD` UTC date. */
export interface TrafficDay {
  day: string
  count: number
  uniques: number
}

/**
 * A 14-day traffic window. The per-day `days` array and the window-level totals
 * are kept as **separate fields** because window `uniques` is non-additive — the
 * derived layer must use `windowUniques` directly and never sum daily uniques
 * (KTD1).
 */
export interface TrafficSeries {
  windowCount: number
  windowUniques: number
  days: TrafficDay[]
}

/** A traffic referrer source. */
export interface Referrer {
  referrer: string
  count: number
  uniques: number
}

/** A normalized release asset; `downloadCount`/`size` clamped to >= 0. */
export interface ReleaseAsset {
  id: number
  name: string
  contentType: string
  size: number
  downloadCount: number
  createdAt: string | null
  updatedAt: string | null
}

/** A normalized release with its flattened, clamped assets. */
export interface Release {
  id: number
  tagName: string
  name: string | null
  draft: boolean
  prerelease: boolean
  createdAt: string | null
  publishedAt: string | null
  assets: ReleaseAsset[]
}

/** A star event. `starredAt` is null when the star+json shape wasn't returned. */
export interface StargazerEvent {
  login: string
  starredAt: string | null
}

/** A fork creation event. */
export interface ForkEvent {
  fullName: string
  createdAt: string | null
}

/**
 * A commit event reduced to what ship-cadence needs: a SHA and the authored
 * timestamp (falling back to the committer date). `committedAt` is null when
 * neither date parsed — such rows are dropped from the cadence series rather
 * than fabricating a date.
 */
export interface CommitEvent {
  sha: string
  committedAt: string | null
}

/** Snapshot of the rate-limit headers from the most recent response. */
export interface RateLimitState {
  /** Requests remaining in the current window (`x-ratelimit-remaining`). */
  remaining: number
  /** Unix epoch seconds when the window resets (`x-ratelimit-reset`). */
  reset: number
  /** The window ceiling (`x-ratelimit-limit`), when present. */
  limit: number | null
}
