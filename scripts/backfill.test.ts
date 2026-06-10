import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  runBackfill,
  buildShipCadence,
  toStarRows,
  toForkRows,
  toShipCadenceRows,
  monthKey,
  throttleDelayMs,
  stableForkId,
  SECONDARY_LIMIT_POINTS_PER_MIN,
  type BackfillDeps,
} from './backfill'
import { GitHubClient, parseCommit } from '@/lib/github/client'
import { stableForkId as captureStableForkId } from '@/app/api/cron/github-capture/capture'
import type {
  CommitEvent,
  ForkEvent,
  Release,
  StargazerEvent,
} from '@/lib/github/types'

/**
 * U7 backfill tests (R8; KTD5, KTD7). Test-first contract for the pure logic and
 * the orchestration seam. NO live GitHub / Supabase: `fetch`, `sleep`, the admin
 * client, and the GitHubClient factory are all injected.
 *
 * What this pins (the execution-note contract):
 *   • pagination walks to completion (the new client.listCommits follows Link);
 *   • the throttle delay is applied between requests;
 *   • idempotent-upsert row mapping (stars/forks → ignoreDuplicates on the
 *     UNIQUE key; the fork id matches capture's scheme);
 *   • ship-cadence is reconstructed from commit + release history and stored as a
 *     timeseries, made idempotent via a delete-then-insert series replace;
 *   • downloads are NEVER backfilled.
 */

// ════════════════════════════════════════════════════════════════════════════
// Helper: a Response-shaped fake for the client.listCommits pagination test.
// ════════════════════════════════════════════════════════════════════════════

interface FakeResponseInit {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}

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

// ════════════════════════════════════════════════════════════════════════════
// Helper: a recording fake of the chainable Supabase admin query builder.
// Adapted from capture.test.ts; adds .delete() for the ship-cadence replace.
// ════════════════════════════════════════════════════════════════════════════

interface RecordedOp {
  table: string
  op: 'insert' | 'upsert' | 'delete' | 'select'
  payload?: unknown
  onConflict?: string
  ignoreDuplicates?: boolean
  filters: Array<{ kind: string; args: unknown[] }>
}

function makeFakeAdmin(
  projectRows: Array<{ id: string; owner: string; repo: string }>,
  responses: Record<string, { data?: unknown; error?: unknown }> = {}
) {
  const ops: RecordedOp[] = []

  function builder(table: string) {
    const current: RecordedOp = { table, op: 'select', filters: [] }

    const resolveTerminal = () => {
      // The projects SELECT (the only read) resolves to the seeded rows.
      if (table === 'projects' && current.op === 'select') {
        return Promise.resolve({ data: projectRows, error: null })
      }
      const resp = responses[`${table}.${current.op}`] ?? { data: null, error: null }
      return Promise.resolve({ data: resp.data ?? null, error: resp.error ?? null })
    }

    const chain: Record<string, unknown> = {}
    chain.insert = (payload: unknown) => {
      current.op = 'insert'
      current.payload = payload
      ops.push(current)
      return resolveTerminal()
    }
    chain.upsert = (
      payload: unknown,
      opts?: { onConflict?: string; ignoreDuplicates?: boolean }
    ) => {
      current.op = 'upsert'
      current.payload = payload
      current.onConflict = opts?.onConflict
      current.ignoreDuplicates = opts?.ignoreDuplicates
      ops.push(current)
      return resolveTerminal()
    }
    chain.delete = () => {
      current.op = 'delete'
      ops.push(current)
      return chain // .delete().eq().eq() — terminal via .then()
    }
    chain.select = (_cols?: string) => {
      if (current.op === 'select') ops.push(current)
      return chain
    }
    chain.eq = (col: string, val: unknown) => {
      current.filters.push({ kind: 'eq', args: [col, val] })
      return chain
    }
    chain.is = (col: string, val: unknown) => {
      current.filters.push({ kind: 'is', args: [col, val] })
      return chain
    }
    chain.then = (
      onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
      onRejected?: (e: unknown) => unknown
    ) => resolveTerminal().then(onFulfilled, onRejected)
    return chain
  }

  const admin = { from: (table: string) => builder(table) }
  return { admin, ops }
}

// ════════════════════════════════════════════════════════════════════════════
// Helper: a fake GitHubClient with canned signals, consumed per repo in order.
// ════════════════════════════════════════════════════════════════════════════

interface FakeClientData {
  stargazers?: StargazerEvent[]
  forks?: ForkEvent[]
  commits?: CommitEvent[]
  releases?: Release[]
}

function makeFakeClient(data: FakeClientData) {
  return {
    async listStargazers() {
      return data.stargazers ?? []
    },
    async listForks() {
      return data.forks ?? []
    },
    async listCommits() {
      return data.commits ?? []
    },
    async listReleases() {
      return data.releases ?? []
    },
  }
}

const FIXED_NOW = '2026-06-10T07:00:00.000Z'

function depsFor(
  projectRows: Array<{ id: string; owner: string; repo: string }>,
  clientDatas: FakeClientData[],
  overrides: Partial<BackfillDeps> = {},
  responses: Record<string, { data?: unknown; error?: unknown }> = {}
) {
  const { admin, ops } = makeFakeAdmin(projectRows, responses)
  const queue = [...clientDatas]
  const sleep = vi.fn(async (_ms: number) => {})
  const deps: BackfillDeps = {
    admin: admin as unknown as BackfillDeps['admin'],
    makeClient: () =>
      makeFakeClient(queue.shift() ?? {}) as unknown as ReturnType<
        BackfillDeps['makeClient']
      >,
    sleep,
    now: () => new Date(FIXED_NOW),
    ...overrides,
  }
  return { deps, ops, sleep }
}

function release(partial: Partial<Release>): Release {
  return {
    id: 1,
    tagName: 'v1',
    name: null,
    draft: false,
    prerelease: false,
    createdAt: null,
    publishedAt: null,
    assets: [],
    ...partial,
  }
}

const PROJECT = { id: 'p1', owner: 'phdemotions', repo: 'citegeist' }

beforeEach(() => {
  vi.clearAllMocks()
})

// ════════════════════════════════════════════════════════════════════════════
// 1. Pagination walks to completion (client.listCommits follows Link).
// ════════════════════════════════════════════════════════════════════════════

describe('GitHubClient.listCommits — pagination walks to completion', () => {
  it('follows the Link rel=next chain and concatenates every page', async () => {
    const page1 = [
      { sha: 'a1', commit: { author: { date: '2026-01-10T00:00:00Z' } } },
      { sha: 'a2', commit: { author: { date: '2026-01-20T00:00:00Z' } } },
    ]
    const page2 = [
      { sha: 'b1', commit: { committer: { date: '2026-02-05T00:00:00Z' } } },
    ]
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      if (calls.length === 1) {
        return fakeResponse({
          body: page1,
          headers: {
            link: '<https://api.github.com/repositories/1/commits?page=2>; rel="next"',
          },
        })
      }
      return fakeResponse({ body: page2 }) // no Link → walk ends
    }) as unknown as typeof fetch

    const client = new GitHubClient({ token: 't', fetch: fetchImpl })
    const commits = await client.listCommits('phdemotions', 'citegeist', {
      perPage: 100,
    })

    expect(calls).toHaveLength(2)
    expect(commits.map((c) => c.sha)).toEqual(['a1', 'a2', 'b1'])
    // Author date preferred; committer date used when author is absent.
    expect(commits[0].committedAt).toBe('2026-01-10T00:00:00Z')
    expect(commits[2].committedAt).toBe('2026-02-05T00:00:00Z')
    // The first request carried per_page=100.
    expect(calls[0]).toContain('per_page=100')
  })

  it('passes a `since` filter and clamps per_page into [1,100]', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return fakeResponse({ body: [] })
    }) as unknown as typeof fetch

    const client = new GitHubClient({ token: 't', fetch: fetchImpl })
    await client.listCommits('o', 'r', { since: '2026-01-01T00:00:00Z', perPage: 500 })

    expect(calls[0]).toContain('since=2026-01-01')
    expect(calls[0]).toContain('per_page=100') // 500 clamped to the 100 max
  })

  it('honors maxPages — stops the walk even when a next link is present', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      // Always advertise a next page; maxPages must stop the walk regardless.
      return fakeResponse({
        body: [{ sha: `s${calls.length}`, commit: { author: { date: '2026-01-01T00:00:00Z' } } }],
        headers: {
          link: '<https://api.github.com/repositories/1/commits?page=99>; rel="next"',
        },
      })
    }) as unknown as typeof fetch

    const client = new GitHubClient({ token: 't', fetch: fetchImpl })
    const commits = await client.listCommits('o', 'r', { maxPages: 2 })

    expect(calls).toHaveLength(2)
    expect(commits).toHaveLength(2)
  })
})

describe('parseCommit — degrades safely', () => {
  it('returns null committedAt when neither author nor committer date is present', () => {
    expect(parseCommit({ sha: 'x' }).committedAt).toBeNull()
    expect(parseCommit({}).sha).toBe('')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. Throttle delay is applied between requests.
// ════════════════════════════════════════════════════════════════════════════

describe('throttleDelayMs — stays under the secondary limit', () => {
  it('sizes the delay from the points/min budget (default 900 → 50% → ~133ms)', () => {
    const d = throttleDelayMs(SECONDARY_LIMIT_POINTS_PER_MIN)
    expect(d).toBe(Math.ceil(60_000 / (900 * 0.5))) // 134ms
    expect(d).toBeGreaterThan(0)
  })

  it('falls back to the ceiling for a non-positive / non-finite budget', () => {
    const fallback = throttleDelayMs(SECONDARY_LIMIT_POINTS_PER_MIN)
    expect(throttleDelayMs(0)).toBe(fallback)
    expect(throttleDelayMs(Number.NaN)).toBe(fallback)
    expect(throttleDelayMs(-100)).toBe(fallback)
  })

  it('a tighter budget yields a longer delay (monotonic)', () => {
    expect(throttleDelayMs(100)).toBeGreaterThan(throttleDelayMs(900))
  })
})

describe('runBackfill — applies the throttle between requests', () => {
  it('awaits deps.sleep between the per-repo GitHub calls', async () => {
    const { deps, sleep } = depsFor(
      [PROJECT],
      [
        {
          stargazers: [{ login: 'a', starredAt: '2026-01-01T00:00:00Z' }],
          forks: [{ fullName: 'x/citegeist', createdAt: '2026-02-01T00:00:00Z' }],
          commits: [{ sha: 'c1', committedAt: '2026-03-01T00:00:00Z' }],
          releases: [],
        },
      ]
    )

    await runBackfill(deps)

    // One repo makes 4 GitHub reads (stars, forks, commits, releases); the
    // worker sleeps after stars, after forks, and after commits → 3 sleeps.
    expect(sleep).toHaveBeenCalledTimes(3)
    // The delay passed is the throttle budget (default), > 0.
    expect(sleep.mock.calls.every(([ms]) => (ms as number) > 0)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. Idempotent-upsert row mapping (stars / forks).
// ════════════════════════════════════════════════════════════════════════════

describe('toStarRows / toForkRows — idempotent mapping', () => {
  it('maps stargazers, dropping rows without a starred_at or login', () => {
    const rows = toStarRows(
      'o/r',
      [
        { login: 'alice', starredAt: '2026-01-01T00:00:00Z' },
        { login: 'bob', starredAt: null }, // dropped — no timestamp
        { login: '', starredAt: '2026-01-02T00:00:00Z' }, // dropped — no login
      ],
      FIXED_NOW
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      repo: 'o/r',
      github_user: 'alice',
      starred_at: '2026-01-01T00:00:00Z',
      captured_at: FIXED_NOW,
    })
  })

  it('maps forks with a stable id matching capture, dropping nameless/dateless', () => {
    const rows = toForkRows(
      'o/r',
      [
        { fullName: 'someone/r-fork', createdAt: '2026-02-01T00:00:00Z' },
        { fullName: '', createdAt: '2026-02-02T00:00:00Z' }, // dropped — no name
        { fullName: 'z/r-fork', createdAt: null }, // dropped — no date
      ],
      FIXED_NOW
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].fork_id).toBe(stableForkId('someone/r-fork'))
    // The id MUST agree with the capture-path scheme so the two never duplicate.
    expect(rows[0].fork_id).toBe(captureStableForkId('someone/r-fork'))
  })

  it('stableForkId is deterministic, positive, safe-int', () => {
    const a = stableForkId('owner/repo')
    expect(stableForkId('owner/repo')).toBe(a)
    expect(stableForkId('owner/other')).not.toBe(a)
    expect(a).toBeGreaterThan(0)
    expect(Number.isSafeInteger(a)).toBe(true)
  })
})

describe('runBackfill — stars/forks upserted with ignoreDuplicates (idempotent)', () => {
  it('upserts on the UNIQUE key with ignoreDuplicates=true', async () => {
    const { deps, ops } = depsFor(
      [PROJECT],
      [
        {
          stargazers: [{ login: 'alice', starredAt: '2026-01-01T00:00:00Z' }],
          forks: [{ fullName: 'x/citegeist', createdAt: '2026-02-01T00:00:00Z' }],
        },
      ]
    )

    await runBackfill(deps)

    const starUpsert = ops.find((o) => o.table === 'stars' && o.op === 'upsert')!
    expect(starUpsert.onConflict).toBe('repo,github_user')
    expect(starUpsert.ignoreDuplicates).toBe(true)

    const forkUpsert = ops.find((o) => o.table === 'forks' && o.op === 'upsert')!
    expect(forkUpsert.onConflict).toBe('repo,fork_id')
    expect(forkUpsert.ignoreDuplicates).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. Ship-cadence reconstruction + idempotent timeseries replace.
// ════════════════════════════════════════════════════════════════════════════

describe('buildShipCadence — commit + release history → monthly timeseries', () => {
  it('buckets commits and releases by UTC month and counts events', () => {
    const commits: CommitEvent[] = [
      { sha: 'c1', committedAt: '2026-01-05T10:00:00Z' },
      { sha: 'c2', committedAt: '2026-01-25T10:00:00Z' },
      { sha: 'c3', committedAt: '2026-03-02T10:00:00Z' },
    ]
    const releases: Release[] = [
      release({ publishedAt: '2026-01-30T00:00:00Z' }), // Jan
      release({ createdAt: '2026-03-15T00:00:00Z', publishedAt: null }), // Mar (falls back to createdAt)
    ]

    const buckets = buildShipCadence(commits, releases)

    expect(buckets).toEqual([
      { monthStart: '2026-01-01T00:00:00.000Z', value: 3 }, // 2 commits + 1 release
      { monthStart: '2026-03-01T00:00:00.000Z', value: 2 }, // 1 commit + 1 release
    ])
    // Sorted ascending; the empty February is omitted (gap = no shipping).
    expect(buckets.map((b) => b.monthStart)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ])
  })

  it('excludes draft releases and undated events', () => {
    const buckets = buildShipCadence(
      [{ sha: 'c1', committedAt: null }], // undated commit dropped
      [
        release({ draft: true, publishedAt: '2026-01-01T00:00:00Z' }), // draft dropped
        release({ publishedAt: '2026-02-01T00:00:00Z' }),
      ]
    )
    expect(buckets).toEqual([{ monthStart: '2026-02-01T00:00:00.000Z', value: 1 }])
  })

  it('returns [] for a repo with no shippable history', () => {
    expect(buildShipCadence([], [])).toEqual([])
  })

  it('monthKey parses or degrades to null', () => {
    expect(monthKey('2026-06-10T07:00:00Z')).toBe('2026-06')
    expect(monthKey('not-a-date')).toBeNull()
    expect(monthKey(null)).toBeNull()
  })

  it('toShipCadenceRows tags the snapshot rows as a github timeseries', () => {
    const rows = toShipCadenceRows('p1', [
      { monthStart: '2026-01-01T00:00:00.000Z', value: 3 },
    ])
    expect(rows[0]).toEqual({
      project_id: 'p1',
      source: 'github',
      metric: 'ship_cadence',
      value: 3,
      data_class: 'timeseries',
      captured_at: '2026-01-01T00:00:00.000Z',
    })
  })
})

describe('runBackfill — ship-cadence is replaced idempotently (delete then insert)', () => {
  it('deletes existing ship_cadence rows for the project, then inserts buckets', async () => {
    const { deps, ops } = depsFor(
      [PROJECT],
      [
        {
          commits: [
            { sha: 'c1', committedAt: '2026-01-05T00:00:00Z' },
            { sha: 'c2', committedAt: '2026-02-05T00:00:00Z' },
          ],
          releases: [release({ publishedAt: '2026-02-20T00:00:00Z' })],
        },
      ]
    )

    await runBackfill(deps)

    // A delete scoped to (project_id=p1, metric=ship_cadence) precedes the insert.
    const del = ops.find(
      (o) => o.table === 'signal_snapshots' && o.op === 'delete'
    )!
    expect(del).toBeDefined()
    expect(del.filters).toEqual(
      expect.arrayContaining([
        { kind: 'eq', args: ['project_id', 'p1'] },
        { kind: 'eq', args: ['metric', 'ship_cadence'] },
      ])
    )

    const ins = ops.find(
      (o) => o.table === 'signal_snapshots' && o.op === 'insert'
    )!
    const rows = ins.payload as Array<Record<string, unknown>>
    expect(rows.every((r) => r.metric === 'ship_cadence')).toBe(true)
    expect(rows.every((r) => r.data_class === 'timeseries')).toBe(true)
    // Jan (1 commit) + Feb (1 commit + 1 release) → 2 buckets.
    expect(rows).toHaveLength(2)
    const feb = rows.find((r) => r.captured_at === '2026-02-01T00:00:00.000Z')!
    expect(feb.value).toBe(2)

    // Idempotency mechanism: the delete is ordered before the insert.
    const delIdx = ops.indexOf(del)
    const insIdx = ops.indexOf(ins)
    expect(delIdx).toBeLessThan(insIdx)
  })

  it('still clears the series (delete) when there is no shippable history', async () => {
    const { deps, ops } = depsFor([PROJECT], [{ commits: [], releases: [] }])

    await runBackfill(deps)

    // Delete still runs (so a previously-populated series is cleared), but with
    // zero buckets there is NO insert.
    expect(
      ops.some((o) => o.table === 'signal_snapshots' && o.op === 'delete')
    ).toBe(true)
    expect(
      ops.some((o) => o.table === 'signal_snapshots' && o.op === 'insert')
    ).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. Downloads are NEVER backfilled.
// ════════════════════════════════════════════════════════════════════════════

describe('runBackfill — downloads are NOT backfillable', () => {
  it('never writes a downloads (or downloads_span_days) snapshot, even with release assets', async () => {
    const { deps, ops } = depsFor(
      [PROJECT],
      [
        {
          // Releases carry download_count assets — backfill must IGNORE them for
          // download history (cumulative, no time-series). They feed cadence only.
          releases: [
            release({
              publishedAt: '2026-01-01T00:00:00Z',
              assets: [
                {
                  id: 1,
                  name: 'app.zip',
                  contentType: 'application/zip',
                  size: 100,
                  downloadCount: 9999,
                  createdAt: null,
                  updatedAt: null,
                },
              ],
            }),
          ],
        },
      ]
    )

    await runBackfill(deps)

    const snapshotInserts = ops.filter(
      (o) => o.table === 'signal_snapshots' && o.op === 'insert'
    )
    const allRows = snapshotInserts.flatMap((o) =>
      Array.isArray(o.payload) ? o.payload : [o.payload]
    ) as Array<Record<string, unknown>>

    const metrics = new Set(allRows.map((r) => r.metric))
    expect(metrics.has('downloads')).toBe(false)
    expect(metrics.has('downloads_span_days')).toBe(false)
    // The only snapshot metric backfill writes is ship_cadence.
    expect([...metrics]).toEqual(['ship_cadence'])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. Orchestration — multi-repo, failure isolation, dry-run.
// ════════════════════════════════════════════════════════════════════════════

describe('runBackfill — orchestration', () => {
  it('processes every tracked repo and reports per-repo tallies', async () => {
    const { deps, summary } = await (async () => {
      const { deps } = depsFor(
        [
          { id: 'p1', owner: 'o', repo: 'a' },
          { id: 'p2', owner: 'o', repo: 'b' },
        ],
        [
          {
            stargazers: [{ login: 'u', starredAt: '2026-01-01T00:00:00Z' }],
            commits: [{ sha: 'c', committedAt: '2026-01-02T00:00:00Z' }],
          },
          {
            forks: [{ fullName: 'x/b', createdAt: '2026-01-03T00:00:00Z' }],
          },
        ]
      )
      const summary = await runBackfill(deps)
      return { deps, summary }
    })()
    void deps

    expect(summary.reposTotal).toBe(2)
    expect(summary.reposOk).toBe(2)
    expect(summary.reposFailed).toBe(0)
    expect(summary.results[0]).toMatchObject({
      repo: 'o/a',
      starsUpserted: 1,
      shipCadenceBuckets: 1,
      shipEvents: 1,
    })
    expect(summary.results[1]).toMatchObject({ repo: 'o/b', forksUpserted: 1 })
  })

  it('isolates a single repo failure without aborting the run', async () => {
    const { admin, ops } = makeFakeAdmin([
      { id: 'p1', owner: 'o', repo: 'a' },
      { id: 'p2', owner: 'o', repo: 'b' },
    ])
    const sleep = vi.fn(async () => {})
    let call = 0
    const deps: BackfillDeps = {
      admin: admin as unknown as BackfillDeps['admin'],
      makeClient: () => {
        call += 1
        if (call === 1) {
          // First repo's client throws mid-walk.
          return {
            async listStargazers() {
              throw new Error('boom')
            },
            async listForks() {
              return []
            },
            async listCommits() {
              return []
            },
            async listReleases() {
              return []
            },
          } as unknown as ReturnType<BackfillDeps['makeClient']>
        }
        return makeFakeClient({
          stargazers: [{ login: 'u', starredAt: '2026-01-01T00:00:00Z' }],
        }) as unknown as ReturnType<BackfillDeps['makeClient']>
      },
      sleep,
      now: () => new Date(FIXED_NOW),
    }

    const summary = await runBackfill(deps)

    expect(summary.reposTotal).toBe(2)
    expect(summary.reposOk).toBe(1)
    expect(summary.reposFailed).toBe(1)
    expect(summary.failures[0].repo).toBe('o/a')
    // The second repo still got its star upsert despite the first throwing.
    expect(ops.some((o) => o.table === 'stars' && o.op === 'upsert')).toBe(true)
  })

  it('dry-run walks GitHub and computes tallies but writes nothing', async () => {
    const { deps, ops } = depsFor(
      [PROJECT],
      [
        {
          stargazers: [{ login: 'u', starredAt: '2026-01-01T00:00:00Z' }],
          forks: [{ fullName: 'x/citegeist', createdAt: '2026-02-01T00:00:00Z' }],
          commits: [{ sha: 'c', committedAt: '2026-03-01T00:00:00Z' }],
        },
      ],
      { dryRun: true }
    )

    const summary = await runBackfill(deps)

    // Tallies still computed from the walk…
    expect(summary.results[0]).toMatchObject({
      starsUpserted: 1,
      forksUpserted: 1,
      shipCadenceBuckets: 1,
    })
    // …but NO write op of any kind was issued (only the projects SELECT).
    const writeOps = ops.filter((o) => o.op !== 'select')
    expect(writeOps).toHaveLength(0)
  })

  it('surfaces a projects SELECT error', async () => {
    const { admin } = makeFakeAdmin([], { 'projects.select': { error: new Error('db down') } })
    // Override the projects read to error (the fake resolves projects SELECT to
    // rows by default, so wrap it).
    const erroringAdmin = {
      from: (t: string) => {
        const chain = admin.from(t) as Record<string, unknown>
        if (t === 'projects') {
          chain.then = (onF: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: new Error('db down') }).then(onF)
        }
        return chain
      },
    }
    const deps: BackfillDeps = {
      admin: erroringAdmin as unknown as BackfillDeps['admin'],
      makeClient: () => makeFakeClient({}) as unknown as ReturnType<BackfillDeps['makeClient']>,
      sleep: vi.fn(async () => {}),
      now: () => new Date(FIXED_NOW),
    }

    await expect(runBackfill(deps)).rejects.toThrow('db down')
  })
})
