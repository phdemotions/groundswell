/**
 * GitHub REST API client — U3 (KTD5, KTD8).
 *
 * A typed, rate-aware, paginated **read** client over raw `fetch` for every v1
 * signal. Mirrors the auth/header shape of `faculty-meeting/api/feedback.js`
 * (Bearer + `application/vnd.github+json` + `X-GitHub-Api-Version`) and the
 * typed paginated external-client style of `claritas/src/lib/openalex/`.
 *
 * Design contract:
 *   - Every call carries the three required headers (KTD5).
 *   - Watchers come from `subscribers_count`, NEVER `watchers_count` (KTD8).
 *   - Traffic returns per-day rows AND window-level totals as separate fields;
 *     window `uniques` is non-additive and is kept distinct (KTD1).
 *   - Pagination follows the `Link` header `rel="next"` to completion.
 *   - `x-ratelimit-remaining` / `x-ratelimit-reset` are read off every response.
 *   - A 403 carrying `Retry-After` (or a zero-remaining `x-ratelimit-reset`)
 *     triggers a bounded backoff that HONORS the header — it does not throw.
 *   - Every field read is null-guarded and bounds-clamped: payloads evolve, so
 *     the client degrades to safe values rather than crashing.
 *
 * READ-ONLY by design — there is no write surface here. The fine-grained PAT is
 * `Administration:Read` + `Contents:Read` + `Metadata:Read`, repo-scoped (KTD5).
 *
 * @see https://docs.github.com/en/rest
 */

import type {
  CommitEvent,
  ForkEvent,
  RateLimitState,
  RawCommit,
  RawFork,
  RawReferrer,
  RawRelease,
  RawReleaseAsset,
  RawRepo,
  RawStargazer,
  RawTrafficDay,
  RawTrafficResponse,
  Referrer,
  Release,
  ReleaseAsset,
  RepoSummary,
  StargazerEvent,
  TrafficDay,
  TrafficSeries,
} from './types'

// ============================================================================
// Constants
// ============================================================================

const GITHUB_API_BASE = 'https://api.github.com'
const ACCEPT_JSON = 'application/vnd.github+json'
const ACCEPT_STAR_JSON = 'application/vnd.github.star+json'
const API_VERSION = '2022-11-28'

/** GitHub paginated endpoints default to 30/page; 100 is the max. */
const MAX_PER_PAGE = 100

/**
 * The stargazers endpoint is paginated and GitHub caps it at ~400 pages
 * (~40,000 stars) — beyond that the API stops returning a `rel="next"` link, so
 * the full star history of a very popular repo is not reconstructable past the
 * cap. None of the tracked v1 repos approach this, but the limit is documented
 * here so a future consumer doesn't read a truncated curve as ground truth.
 * @see https://docs.github.com/en/rest/activity/starring
 */
export const STARGAZER_PAGE_CAP = 400

/** Default backoff retries for a 403 secondary-rate-limit response. */
const DEFAULT_MAX_RETRIES = 2

// ============================================================================
// Error
// ============================================================================

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body?: string
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

// ============================================================================
// Null-guard / bounds-clamp helpers (payloads evolve → degrade, never crash)
// ============================================================================

/** Coerce to a finite integer clamped to `>= 0`; anything else degrades to 0. */
function clampInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const floored = Math.floor(value)
  return floored < 0 ? 0 : floored
}

/** A non-empty trimmed string, or the fallback. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** A string when present and non-empty, else null (never an invented value). */
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A boolean, defaulting to false for any non-boolean. */
function bool(value: unknown): boolean {
  return value === true
}

/** The `YYYY-MM-DD` UTC date from an ISO timestamp, or '' if unparseable. */
function isoDay(timestamp: unknown): string {
  if (typeof timestamp !== 'string' || timestamp.length === 0) return ''
  const ms = Date.parse(timestamp)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toISOString().slice(0, 10)
}

/** Treat a possibly-null array as an array. */
function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : []
}

// ============================================================================
// Client
// ============================================================================

export interface GitHubClientOptions {
  /** Fine-grained PAT (read-only, repo-scoped — KTD5). */
  token: string
  /** Injectable fetch (defaults to the global). Lets tests run hermetically. */
  fetch?: typeof fetch
  /** Injectable sleep (defaults to setTimeout). Lets tests assert backoff. */
  sleep?: (ms: number) => Promise<void>
  /** Backoff retries for a 403 secondary-rate-limit (default 2). */
  maxRetries?: number
  /** API base override (defaults to https://api.github.com). */
  baseUrl?: string
  /**
   * Optional AbortSignal threaded into every fetch — the capture route's
   * abort-budget (U4) cancels in-flight requests through this.
   */
  signal?: AbortSignal
}

interface RequestOptions {
  /** Override the Accept header (stargazers needs star+json). */
  accept?: string
}

export class GitHubClient {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number
  private readonly baseUrl: string
  private readonly signal?: AbortSignal

  /** The rate-limit snapshot from the most recent response, if any. */
  public rateLimit: RateLimitState | null = null

  constructor(options: GitHubClientOptions) {
    this.token = options.token
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.sleep = options.sleep ?? defaultSleep
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.baseUrl = options.baseUrl ?? GITHUB_API_BASE
    this.signal = options.signal
  }

  // ── Header construction (KTD5: on every call) ────────────────────────────

  private headers(accept: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': API_VERSION,
    }
  }

  // ── Rate-limit header capture ─────────────────────────────────────────────

  private captureRateLimit(res: GitHubResponse): void {
    const remaining = res.headers.get('x-ratelimit-remaining')
    const reset = res.headers.get('x-ratelimit-reset')
    if (remaining === null && reset === null) return
    const limit = res.headers.get('x-ratelimit-limit')
    this.rateLimit = {
      remaining: remaining === null ? 0 : Number.parseInt(remaining, 10) || 0,
      reset: reset === null ? 0 : Number.parseInt(reset, 10) || 0,
      limit: limit === null ? null : Number.parseInt(limit, 10) || 0,
    }
  }

  // ── Backoff math: honor Retry-After, fall back to x-ratelimit-reset ───────

  private backoffMs(res: GitHubResponse): number {
    const retryAfter = res.headers.get('retry-after')
    if (retryAfter !== null) {
      const seconds = Number.parseInt(retryAfter, 10)
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    }
    // No Retry-After: if the primary limit is exhausted, wait until reset.
    const remaining = res.headers.get('x-ratelimit-remaining')
    const reset = res.headers.get('x-ratelimit-reset')
    if (remaining === '0' && reset !== null) {
      const resetSec = Number.parseInt(reset, 10)
      if (Number.isFinite(resetSec)) {
        const deltaMs = resetSec * 1000 - Date.now()
        return deltaMs > 0 ? deltaMs : 0
      }
    }
    return 0
  }

  // ── Core request: rate-aware, 403-backoff-aware (does not throw on 403) ───

  private async request(path: string, options: RequestOptions = {}): Promise<{
    body: unknown
    link: string | null
  }> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`
    const accept = options.accept ?? ACCEPT_JSON

    let attempt = 0
    // attempts = 1 initial + maxRetries backoff retries
    for (;;) {
      const res = (await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers(accept),
        signal: this.signal,
      })) as unknown as GitHubResponse

      this.captureRateLimit(res)

      if (res.ok) {
        return { body: await res.json(), link: res.headers.get('link') }
      }

      // 403 is GitHub's secondary-rate-limit signal. Honor the backoff hint and
      // retry rather than throwing — perishable data depends on the run not
      // dying on a soft limit.
      if (res.status === 403 && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs(res))
        attempt += 1
        continue
      }

      const body = await safeText(res)
      throw new GitHubError(
        `GitHub API ${res.status} for ${url}`,
        res.status,
        url,
        body
      )
    }
  }

  /**
   * Follow the `Link` header `rel="next"` chain to completion, concatenating
   * each page's array. `pageCap` bounds the walk (stargazers, see
   * STARGAZER_PAGE_CAP).
   */
  private async paginate<T>(
    firstPath: string,
    options: RequestOptions = {},
    pageCap = Number.POSITIVE_INFINITY
  ): Promise<T[]> {
    const out: T[] = []
    let next: string | null = firstPath
    let pages = 0
    while (next !== null && pages < pageCap) {
      const { body, link }: { body: unknown; link: string | null } =
        await this.request(next, options)
      for (const item of asArray(body as T[])) out.push(item)
      next = parseNextLink(link)
      pages += 1
    }
    return out
  }

  // ── Signals ────────────────────────────────────────────────────────────

  /**
   * `GET /repos/{owner}/{repo}` → stars / forks / watchers.
   * KTD8: `watchers` is `subscribers_count`, NOT `watchers_count` (the latter is
   * a GitHub alias for the star count).
   */
  async getRepoSummary(owner: string, repo: string): Promise<RepoSummary> {
    const { body } = await this.request(`/repos/${owner}/${repo}`)
    const raw = (body ?? {}) as RawRepo
    return {
      stars: clampInt(raw.stargazers_count),
      forks: clampInt(raw.forks_count),
      watchers: clampInt(raw.subscribers_count),
    }
  }

  /** `GET /repos/{owner}/{repo}/traffic/views` — per-day + window totals. */
  async getTrafficViews(owner: string, repo: string): Promise<TrafficSeries> {
    const { body } = await this.request(
      `/repos/${owner}/${repo}/traffic/views`
    )
    return parseTraffic(body as RawTrafficResponse, 'views')
  }

  /** `GET /repos/{owner}/{repo}/traffic/clones` — per-day + window totals. */
  async getTrafficClones(owner: string, repo: string): Promise<TrafficSeries> {
    const { body } = await this.request(
      `/repos/${owner}/${repo}/traffic/clones`
    )
    return parseTraffic(body as RawTrafficResponse, 'clones')
  }

  /** `GET /repos/{owner}/{repo}/traffic/popular/referrers` — top 10. */
  async getReferrers(owner: string, repo: string): Promise<Referrer[]> {
    const { body } = await this.request(
      `/repos/${owner}/${repo}/traffic/popular/referrers`
    )
    return asArray(body as RawReferrer[])
      .map(parseReferrer)
      .slice(0, 10)
  }

  /**
   * `GET /repos/{owner}/{repo}/releases` — paginated. Returns each release with
   * its flattened, clamped assets (`assets[].download_count`).
   */
  async listReleases(owner: string, repo: string): Promise<Release[]> {
    const raw = await this.paginate<RawRelease>(
      `/repos/${owner}/${repo}/releases?per_page=${MAX_PER_PAGE}`
    )
    return raw.map(parseRelease)
  }

  /**
   * `GET /repos/{owner}/{repo}/stargazers` with the `star+json` media type so
   * each row carries `starred_at`. Paginated via the `Link` header, bounded by
   * STARGAZER_PAGE_CAP (~40k stars).
   */
  async listStargazers(
    owner: string,
    repo: string
  ): Promise<StargazerEvent[]> {
    const raw = await this.paginate<RawStargazer>(
      `/repos/${owner}/${repo}/stargazers?per_page=${MAX_PER_PAGE}`,
      { accept: ACCEPT_STAR_JSON },
      STARGAZER_PAGE_CAP
    )
    return raw.map(parseStargazer)
  }

  /** `GET /repos/{owner}/{repo}/forks` — paginated, each fork's `created_at`. */
  async listForks(owner: string, repo: string): Promise<ForkEvent[]> {
    const raw = await this.paginate<RawFork>(
      `/repos/${owner}/${repo}/forks?per_page=${MAX_PER_PAGE}&sort=oldest`
    )
    return raw.map(parseFork)
  }

  /**
   * `GET /repos/{owner}/{repo}/commits` — paginated commit history for the
   * ship-cadence backfill (U7). Each row is reduced to its SHA + authored
   * timestamp.
   *
   * Used by the backfill burst (the plan's flagged rate-limit risk), so the walk
   * is bounded two ways:
   *   - `since` (ISO 8601) asks GitHub to only return commits at or after a date,
   *     so a re-run can fetch just the recent tail rather than the whole history;
   *   - `maxPages` hard-caps the `Link`-header walk so a very long-lived repo
   *     cannot fan out an unbounded number of requests in one backfill.
   *
   * @see https://docs.github.com/en/rest/commits/commits#list-commits
   */
  async listCommits(
    owner: string,
    repo: string,
    options: { since?: string; perPage?: number; maxPages?: number } = {}
  ): Promise<CommitEvent[]> {
    const perPage = clampPerPage(options.perPage)
    const params = new URLSearchParams({ per_page: String(perPage) })
    if (typeof options.since === 'string' && options.since.length > 0) {
      params.set('since', options.since)
    }
    const maxPages =
      typeof options.maxPages === 'number' && options.maxPages > 0
        ? Math.floor(options.maxPages)
        : Number.POSITIVE_INFINITY
    const raw = await this.paginate<RawCommit>(
      `/repos/${owner}/${repo}/commits?${params.toString()}`,
      {},
      maxPages
    )
    return raw.map(parseCommit)
  }
}

// ============================================================================
// Pure parse functions (exported for direct contract testing)
// ============================================================================

export function parseTraffic(
  raw: RawTrafficResponse | null | undefined,
  key: 'views' | 'clones'
): TrafficSeries {
  const safe = raw ?? {}
  const rows = key === 'views' ? asArray(safe.views) : asArray(safe.clones)
  return {
    windowCount: clampInt(safe.count),
    windowUniques: clampInt(safe.uniques),
    days: rows.map(parseTrafficDay).filter((d) => d.day !== ''),
  }
}

function parseTrafficDay(raw: RawTrafficDay): TrafficDay {
  return {
    day: isoDay(raw?.timestamp),
    count: clampInt(raw?.count),
    uniques: clampInt(raw?.uniques),
  }
}

function parseReferrer(raw: RawReferrer): Referrer {
  return {
    referrer: str(raw?.referrer),
    count: clampInt(raw?.count),
    uniques: clampInt(raw?.uniques),
  }
}

export function parseRelease(raw: RawRelease): Release {
  return {
    id: clampInt(raw?.id),
    tagName: str(raw?.tag_name),
    name: strOrNull(raw?.name),
    draft: bool(raw?.draft),
    prerelease: bool(raw?.prerelease),
    createdAt: strOrNull(raw?.created_at),
    publishedAt: strOrNull(raw?.published_at),
    assets: asArray(raw?.assets).map(parseReleaseAsset),
  }
}

function parseReleaseAsset(raw: RawReleaseAsset): ReleaseAsset {
  return {
    id: clampInt(raw?.id),
    name: str(raw?.name),
    contentType: str(raw?.content_type),
    size: clampInt(raw?.size),
    downloadCount: clampInt(raw?.download_count),
    createdAt: strOrNull(raw?.created_at),
    updatedAt: strOrNull(raw?.updated_at),
  }
}

export function parseStargazer(raw: RawStargazer): StargazerEvent {
  // star+json shape nests the user under `user`; the plain shape IS the user.
  const login = str(raw?.user?.login) || str(raw?.login)
  return {
    login,
    starredAt: strOrNull(raw?.starred_at),
  }
}

function parseFork(raw: RawFork): ForkEvent {
  return {
    fullName: str(raw?.full_name),
    createdAt: strOrNull(raw?.created_at),
  }
}

export function parseCommit(raw: RawCommit): CommitEvent {
  // Prefer the author date (when the work was written); fall back to the
  // committer date (when it landed). Either is a valid ship-cadence signal; a
  // commit with neither is surfaced as null and dropped by the cadence builder.
  const authored = strOrNull(raw?.commit?.author?.date)
  const committed = strOrNull(raw?.commit?.committer?.date)
  return {
    sha: str(raw?.sha),
    committedAt: authored ?? committed,
  }
}

/** Clamp a requested page size into GitHub's `[1, 100]` range; default 100. */
function clampPerPage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_PER_PAGE
  const floored = Math.floor(value)
  if (floored < 1) return 1
  if (floored > MAX_PER_PAGE) return MAX_PER_PAGE
  return floored
}

// ============================================================================
// Link-header parsing
// ============================================================================

/**
 * Extract the `rel="next"` URL from a GitHub `Link` header, or null when there
 * is no next page. Format:
 *   <https://api.github.com/...?page=2>; rel="next", <...>; rel="last"
 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/)
    if (match && match[2] === 'next') return match[1]
  }
  return null
}

// ============================================================================
// Internals
// ============================================================================

/** The minimal slice of the Fetch `Response` this client depends on. */
interface GitHubResponse {
  ok: boolean
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
}

async function safeText(res: GitHubResponse): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
