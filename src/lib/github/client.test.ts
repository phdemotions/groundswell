import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitHubClient, GitHubError } from './client'

import repoSummary from './__fixtures__/repo-summary.json'
import repoSummaryMissing from './__fixtures__/repo-summary-missing-fields.json'
import trafficViews from './__fixtures__/traffic-views.json'
import trafficClones from './__fixtures__/traffic-clones.json'
import referrers from './__fixtures__/referrers.json'
import releasesPage1 from './__fixtures__/releases-page-1.json'
import releasesPage2 from './__fixtures__/releases-page-2.json'
import releaseMissing from './__fixtures__/release-missing-fields.json'
import stargazersStarPage1 from './__fixtures__/stargazers-star-json-page-1.json'
import stargazersStarPage2 from './__fixtures__/stargazers-star-json-page-2.json'
import stargazersPlain from './__fixtures__/stargazers-plain.json'
import forksPage1 from './__fixtures__/forks-page-1.json'
import forksPage2 from './__fixtures__/forks-page-2.json'

/**
 * U3 parsing-contract tests (KTD5, KTD8). Test-first: these define the parse
 * behaviour the client must satisfy. No live GitHub calls — `fetch` and `sleep`
 * are injected, every payload comes from a recorded fixture under __fixtures__.
 */

const TOKEN = 'github_pat_test-token'

// ─── Fake-response helpers ──────────────────────────────────────────────────

interface FakeResponseInit {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}

/** Build a minimal Response-shaped object the client can consume. */
function fakeResponse({ status = 200, headers = {}, body }: FakeResponseInit) {
  const lower = new Map<string, string>()
  for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), v)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/** A captured request: the URL + the headers map passed to fetch. */
interface CapturedCall {
  url: string
  headers: Record<string, string>
}

/**
 * Make a client whose injected fetch replays a queue of responses in order,
 * recording every call. `sleep` is a spy so backoff is assertable without real
 * timers.
 */
function makeClient(responses: ReturnType<typeof fakeResponse>[]) {
  const calls: CapturedCall[] = []
  let i = 0
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    if (i >= responses.length) {
      throw new Error(`unexpected fetch call #${i + 1} to ${String(url)}`)
    }
    return responses[i++] as unknown as Response
  })
  const sleep = vi.fn(async (_ms: number) => {})
  const client = new GitHubClient({
    token: TOKEN,
    fetch: fetchImpl as unknown as typeof fetch,
    sleep,
  })
  return { client, calls, fetchImpl, sleep }
}

const RATE_HEADERS = {
  'x-ratelimit-remaining': '4998',
  'x-ratelimit-reset': '1900000000',
  'x-ratelimit-limit': '5000',
}

// ─── Required headers on every call (KTD5) ──────────────────────────────────

describe('request headers', () => {
  it('sends Bearer auth, the github+json Accept, and the API version on every call', async () => {
    const { client, calls } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: repoSummary }),
    ])
    await client.getRepoSummary('joshgonzales', 'citegeist')

    expect(calls).toHaveLength(1)
    const h = calls[0].headers
    expect(h['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect(h['Accept']).toBe('application/vnd.github+json')
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28')
  })
})

// ─── KTD8: watchers from subscribers_count, NOT watchers_count ───────────────

describe('getRepoSummary — KTD8 watcher mapping', () => {
  it('maps watchers from subscribers_count, never watchers_count', async () => {
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: repoSummary }),
    ])
    const summary = await client.getRepoSummary('joshgonzales', 'citegeist')

    // Fixture: subscribers_count=19, watchers_count=412 (==stars). The trap is
    // returning 412. Watchers MUST be the subscriber count.
    expect(summary.watchers).toBe(19)
    expect(summary.watchers).not.toBe(repoSummary.watchers_count)
    expect(summary.stars).toBe(412)
    expect(summary.forks).toBe(37)
  })

  it('clamps missing/null numeric fields to 0 instead of crashing', async () => {
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: repoSummaryMissing }),
    ])
    const summary = await client.getRepoSummary('joshgonzales', 'young-repo')

    // subscribers_count is null in the fixture → watchers degrades to 0, and
    // must NOT silently fall back to watchers_count (14).
    expect(summary.watchers).toBe(0)
    expect(summary.stars).toBe(0)
    expect(summary.forks).toBe(0)
  })
})

// ─── Traffic: per-day arrays AND window-level totals, kept separate (KTD1) ───

describe('getTrafficViews', () => {
  it('returns per-day rows and the window-level {count,uniques} as separate fields', async () => {
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: trafficViews }),
    ])
    const views = await client.getTrafficViews('joshgonzales', 'citegeist')

    // Window-level totals (non-additive uniques) captured distinct from dailies.
    expect(views.windowCount).toBe(1432)
    expect(views.windowUniques).toBe(274)

    // Per-day series.
    expect(views.days).toHaveLength(7)
    expect(views.days[0]).toEqual({
      day: '2026-05-28',
      count: 121,
      uniques: 38,
    })

    // The window uniques is NOT the sum of daily uniques — proving they are
    // tracked independently (38+31+22+19+41+47+39 = 237 ≠ 274).
    const summedDailyUniques = views.days.reduce((a, d) => a + d.uniques, 0)
    expect(summedDailyUniques).not.toBe(views.windowUniques)
  })
})

describe('getTrafficClones', () => {
  it('returns per-day rows and window-level totals as separate fields', async () => {
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: trafficClones }),
    ])
    const clones = await client.getTrafficClones('joshgonzales', 'citegeist')

    expect(clones.windowCount).toBe(211)
    expect(clones.windowUniques).toBe(63)
    expect(clones.days).toHaveLength(4)
    expect(clones.days[0]).toEqual({
      day: '2026-05-28',
      count: 18,
      uniques: 7,
    })
  })

  it('degrades to an empty window when the payload is missing arrays', async () => {
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: {} }),
    ])
    const clones = await client.getTrafficClones('joshgonzales', 'citegeist')
    expect(clones.windowCount).toBe(0)
    expect(clones.windowUniques).toBe(0)
    expect(clones.days).toEqual([])
  })
})

// ─── Referrers: top-10 ──────────────────────────────────────────────────────

describe('getReferrers', () => {
  it('parses referrer rows and caps the result at the top 10', async () => {
    const many = Array.from({ length: 15 }, (_, n) => ({
      referrer: `ref-${n}.example`,
      count: 100 - n,
      uniques: 50 - n,
    }))
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: many }),
    ])
    const top = await client.getReferrers('joshgonzales', 'citegeist')
    expect(top).toHaveLength(10)
    expect(top[0]).toEqual({ referrer: 'ref-0.example', count: 100, uniques: 50 })
  })

  it('parses the recorded referrers fixture', async () => {
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: referrers }),
    ])
    const top = await client.getReferrers('joshgonzales', 'citegeist')
    expect(top).toHaveLength(5)
    expect(top[0].referrer).toBe('github.com')
    expect(top[2]).toEqual({
      referrer: 'news.ycombinator.com',
      count: 142,
      uniques: 88,
    })
  })
})

// ─── Releases: assets[].download_count, paginated via Link ───────────────────

describe('listReleases', () => {
  it('follows the Link header rel="next" to completion and flattens assets', async () => {
    const linkNext =
      '<https://api.github.com/repositories/1/releases?page=2>; rel="next", ' +
      '<https://api.github.com/repositories/1/releases?page=2>; rel="last"'
    const { client, calls } = makeClient([
      fakeResponse({
        headers: { ...RATE_HEADERS, link: linkNext },
        body: releasesPage1,
      }),
      fakeResponse({ headers: RATE_HEADERS, body: releasesPage2 }),
    ])
    const releases = await client.listReleases('joshgonzales', 'citegeist')

    // 2 + 1 across both pages.
    expect(releases).toHaveLength(3)
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toContain('page=2')

    const v120 = releases.find((r) => r.tagName === 'v1.2.0')!
    expect(v120.assets).toHaveLength(2)
    expect(v120.assets[0].downloadCount).toBe(1843)
    expect(v120.assets.map((a) => a.downloadCount)).toEqual([1843, 921])
  })

  it('null/negative asset fields degrade to clamped values (>= 0)', async () => {
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: releaseMissing }),
    ])
    const releases = await client.listReleases('joshgonzales', 'citegeist')
    expect(releases).toHaveLength(1)
    const assets = releases[0].assets
    expect(assets[0].downloadCount).toBe(0) // was null
    expect(assets[0].size).toBe(0) // was null
    expect(assets[1].downloadCount).toBe(0) // was -12 → clamped
    expect(assets[1].size).toBe(0) // was -5 → clamped
  })
})

// ─── Stargazers: star+json media type → starred_at; paginate ─────────────────

describe('listStargazers', () => {
  it('sends the star+json Accept media type so starred_at is returned', async () => {
    const { client, calls } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: stargazersStarPage1 }),
    ])
    await client.listStargazers('joshgonzales', 'citegeist')
    expect(calls[0].headers['Accept']).toBe('application/vnd.github.star+json')
  })

  it('parses starred_at and paginates via the Link header to completion', async () => {
    const linkNext =
      '<https://api.github.com/repositories/1/stargazers?page=2>; rel="next"'
    const { client, calls } = makeClient([
      fakeResponse({
        headers: { ...RATE_HEADERS, link: linkNext },
        body: stargazersStarPage1,
      }),
      fakeResponse({ headers: RATE_HEADERS, body: stargazersStarPage2 }),
    ])
    const stars = await client.listStargazers('joshgonzales', 'citegeist')

    expect(calls).toHaveLength(2)
    expect(stars).toHaveLength(5)
    expect(stars[0]).toEqual({ login: 'alice', starredAt: '2024-02-01T08:11:00Z' })
    expect(stars[4]).toEqual({ login: 'erin', starredAt: '2025-08-30T22:18:00Z' })
  })

  it('does NOT fabricate starred_at when the plain (non-star+json) shape comes back', async () => {
    // If a caller/proxy strips the media type, the rows have no starred_at. The
    // parser must surface null, never invent a timestamp.
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: stargazersPlain }),
    ])
    const stars = await client.listStargazers('joshgonzales', 'citegeist')
    expect(stars).toHaveLength(3)
    expect(stars[0].login).toBe('alice')
    expect(stars[0].starredAt).toBeNull()
  })
})

// ─── Forks: created_at; paginate ─────────────────────────────────────────────

describe('listForks', () => {
  it('parses created_at and paginates via the Link header', async () => {
    const linkNext =
      '<https://api.github.com/repositories/1/forks?page=2>; rel="next"'
    const { client, calls } = makeClient([
      fakeResponse({
        headers: { ...RATE_HEADERS, link: linkNext },
        body: forksPage1,
      }),
      fakeResponse({ headers: RATE_HEADERS, body: forksPage2 }),
    ])
    const forks = await client.listForks('joshgonzales', 'citegeist')

    expect(calls).toHaveLength(2)
    expect(forks).toHaveLength(3)
    expect(forks[0]).toEqual({
      fullName: 'alice/citegeist',
      createdAt: '2024-03-02T10:00:00Z',
    })
    expect(forks[2].fullName).toBe('carol/citegeist')
  })
})

// ─── Rate-limit awareness ────────────────────────────────────────────────────

describe('rate-limit headers', () => {
  it('reads x-ratelimit-remaining and x-ratelimit-reset off the response', async () => {
    const { client } = makeClient([
      fakeResponse({ headers: RATE_HEADERS, body: repoSummary }),
    ])
    await client.getRepoSummary('joshgonzales', 'citegeist')
    expect(client.rateLimit?.remaining).toBe(4998)
    expect(client.rateLimit?.reset).toBe(1900000000)
  })
})

// ─── 403 + Retry-After → backoff, not a throw ────────────────────────────────

describe('403 secondary-rate-limit handling', () => {
  it('honors Retry-After by sleeping then retrying, returning the eventual body', async () => {
    const { client, sleep, calls } = makeClient([
      fakeResponse({
        status: 403,
        headers: { 'retry-after': '7' },
        body: { message: 'You have exceeded a secondary rate limit.' },
      }),
      fakeResponse({ headers: RATE_HEADERS, body: repoSummary }),
    ])
    const summary = await client.getRepoSummary('joshgonzales', 'citegeist')

    // Backed off honoring the header (7s → 7000ms), did not throw.
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(7000)
    expect(calls).toHaveLength(2)
    expect(summary.stars).toBe(412)
  })

  it('falls back to x-ratelimit-reset when a 403 has no Retry-After', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const { client, sleep } = makeClient([
      fakeResponse({
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(nowSec + 5),
        },
        body: { message: 'API rate limit exceeded' },
      }),
      fakeResponse({ headers: RATE_HEADERS, body: repoSummary }),
    ])
    const summary = await client.getRepoSummary('joshgonzales', 'citegeist')
    expect(sleep).toHaveBeenCalledTimes(1)
    // ~5s wait derived from the reset epoch (allow a little slack).
    const waited = sleep.mock.calls[0]?.[0] ?? 0
    expect(waited).toBeGreaterThanOrEqual(0)
    expect(waited).toBeLessThanOrEqual(6000)
    expect(summary.stars).toBe(412)
  })

  it('gives up after the retry budget and throws a GitHubError', async () => {
    // Three consecutive 403s with the client default of 2 retries → throws.
    const { client, sleep } = makeClient([
      fakeResponse({ status: 403, headers: { 'retry-after': '1' }, body: {} }),
      fakeResponse({ status: 403, headers: { 'retry-after': '1' }, body: {} }),
      fakeResponse({ status: 403, headers: { 'retry-after': '1' }, body: {} }),
    ])
    await expect(
      client.getRepoSummary('joshgonzales', 'citegeist')
    ).rejects.toBeInstanceOf(GitHubError)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})

// ─── Other error statuses ────────────────────────────────────────────────────

describe('non-retryable errors', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  it('throws GitHubError on a 500 without retrying', async () => {
    const { client, calls } = makeClient([
      fakeResponse({ status: 500, headers: RATE_HEADERS, body: 'boom' }),
    ])
    await expect(
      client.getRepoSummary('joshgonzales', 'citegeist')
    ).rejects.toBeInstanceOf(GitHubError)
    expect(calls).toHaveLength(1)
    // sanity: we never touched global fetch
    expect(globalThis.fetch).toBe(originalFetch)
  })
})
