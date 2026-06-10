import { describe, it, expect, beforeEach } from 'vitest'
import {
  runCapture,
  spanDaysSince,
  stableForkId,
  type CaptureDeps,
} from './capture'
import { runBounded, allOk } from '@/lib/capture/runBounded'

/**
 * U4 capture-core tests (KTD1, KTD3). The orchestration is driven with a fake
 * admin client that RECORDS every table operation, a fake GitHubClient factory
 * returning canned signal data, the real `runBounded`/`allOk`, and a fixed
 * clock. No live Supabase, no live GitHub.
 *
 * What this pins (the execution-note contract):
 *   • the route inspects the envelope and advances last_successful_capture_at
 *     ONLY when the whole batch is all-ok (partial / failure leaves it untouched);
 *   • window-level uniques are persisted via traffic_window with the WINDOW
 *     total, never the sum of daily uniques;
 *   • traffic_daily is upserted ON CONFLICT (repo, metric, day) — the
 *     self-healing re-upsert;
 *   • the AbortSignal is threaded into the client (the worker calls makeClient
 *     with deps.signal);
 *   • a download-snapshot gap > 1 day writes a span-days marker (KTD1 / U8);
 *   • a single repo throwing is isolated (envelope), the batch still finishes,
 *     and the run is recorded 'partial'.
 */

// ── A recording fake of the chainable Supabase query builder. ────────────────

interface RecordedOp {
  table: string
  op: 'insert' | 'upsert' | 'update' | 'select'
  payload?: unknown
  onConflict?: string
  ignoreDuplicates?: boolean
  filters: Array<{ kind: string; args: unknown[] }>
}

/**
 * Build a fake admin client. `responses` maps "table.op" → the resolved
 * `{ data, error }` for terminal reads; writes resolve `{ data: null, error: null }`
 * unless overridden. Every operation is pushed to `ops` for assertions.
 */
function makeFakeAdmin(
  responses: Record<string, { data?: unknown; error?: unknown }> = {}
) {
  const ops: RecordedOp[] = []

  function builder(table: string) {
    const current: RecordedOp = { table, op: 'select', filters: [] }

    const chain: Record<string, unknown> = {}

    const finalize = (key: string) => {
      const resp = responses[`${table}.${current.op}`] ??
        responses[`${table}.${key}`] ?? { data: null, error: null }
      return Promise.resolve({ data: resp.data ?? null, error: resp.error ?? null })
    }

    chain.insert = (payload: unknown) => {
      current.op = 'insert'
      current.payload = payload
      ops.push(current)
      // insert may be terminal OR followed by .select().single()
      return chain
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
      return Promise.resolve(
        responses[`${table}.upsert`] ?? { data: null, error: null }
      )
    }
    chain.update = (payload: unknown) => {
      current.op = 'update'
      current.payload = payload
      ops.push(current)
      return chain
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
    chain.order = (col: string, opts?: unknown) => {
      current.filters.push({ kind: 'order', args: [col, opts] })
      return chain
    }
    chain.limit = (n: number) => {
      current.filters.push({ kind: 'limit', args: [n] })
      return chain
    }
    chain.single = () => finalize('single')
    chain.maybeSingle = () => finalize('maybeSingle')
    // Terminal awaits (e.g. update/insert without .single()) resolve via then.
    chain.then = (
      onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
      onRejected?: (e: unknown) => unknown
    ) => {
      const resp = responses[`${table}.${current.op}`] ?? {
        data: null,
        error: null,
      }
      return Promise.resolve({
        data: resp.data ?? null,
        error: resp.error ?? null,
      }).then(onFulfilled, onRejected)
    }
    return chain
  }

  const admin = { from: (table: string) => builder(table) }
  return { admin, ops }
}

// ── A fake GitHubClient with canned signals. ─────────────────────────────────

interface FakeClientData {
  summary?: { stars: number; forks: number; watchers: number }
  views?: { windowCount: number; windowUniques: number; days: TDay[] }
  clones?: { windowCount: number; windowUniques: number; days: TDay[] }
  referrers?: Array<{ referrer: string; count: number; uniques: number }>
  releases?: Array<{ assets: Array<{ downloadCount: number }> }>
  stargazers?: Array<{ login: string; starredAt: string | null }>
  forks?: Array<{ fullName: string; createdAt: string | null }>
  throwOn?: keyof FakeClientData
}
interface TDay {
  day: string
  count: number
  uniques: number
}

function makeFakeClient(data: FakeClientData, seenSignals: unknown[]) {
  const guard = (key: keyof FakeClientData) => {
    if (data.throwOn === key) throw new Error(`boom:${String(key)}`)
  }
  return {
    async getRepoSummary() {
      guard('summary')
      return data.summary ?? { stars: 0, forks: 0, watchers: 0 }
    },
    async getTrafficViews() {
      guard('views')
      return data.views ?? { windowCount: 0, windowUniques: 0, days: [] }
    },
    async getTrafficClones() {
      guard('clones')
      return data.clones ?? { windowCount: 0, windowUniques: 0, days: [] }
    },
    async getReferrers() {
      guard('referrers')
      return data.referrers ?? []
    },
    async listReleases() {
      guard('releases')
      return data.releases ?? []
    },
    async listStargazers() {
      guard('stargazers')
      return data.stargazers ?? []
    },
    async listForks() {
      guard('forks')
      return data.forks ?? []
    },
    __recordSignal(signal: unknown) {
      seenSignals.push(signal)
    },
  }
}

const FIXED_NOW = '2026-06-10T07:00:00.000Z'

function baseDeps(
  admin: { from: (t: string) => unknown },
  clientData: Record<string, FakeClientData>,
  seenSignals: unknown[],
  abortSignal: AbortSignal | undefined = undefined
): CaptureDeps {
  return {
    admin: admin as unknown as CaptureDeps['admin'],
    signal: abortSignal,
    makeClient: (signal) => {
      seenSignals.push(signal)
      // Decide which repo's data to return based on call order — the worker
      // builds one client per repo, so we pop the next dataset.
      const next = clientQueue.shift() ?? {}
      return makeFakeClient(next, seenSignals) as unknown as ReturnType<
        CaptureDeps['makeClient']
      >
    },
    runBounded,
    allOk,
    concurrency: 2,
    now: () => new Date(FIXED_NOW),
  }
  // NB: clientQueue is assigned by the caller via withClientData()
}

// A per-test queue of client datasets, consumed in worker order.
let clientQueue: FakeClientData[] = []

beforeEach(() => {
  clientQueue = []
})

const PROJECT_ROWS = [
  { id: 'p1', owner: 'phdemotions', repo: 'citegeist' },
  { id: 'p2', owner: 'phdemotions', repo: 'provenance' },
]

function depsFor(
  responses: Record<string, { data?: unknown; error?: unknown }>,
  clientDatas: FakeClientData[],
  abortSignal?: AbortSignal
) {
  const { admin, ops } = makeFakeAdmin(responses)
  const seenSignals: unknown[] = []
  clientQueue = clientDatas
  const deps = baseDeps(admin, {}, seenSignals, abortSignal)
  return { deps, ops, seenSignals }
}

describe('runCapture — watchdog clock advances ONLY on all-ok (KTD3)', () => {
  it('advances last_successful_capture_at when every repo succeeds', async () => {
    const { deps, ops } = depsFor(
      {
        'capture_runs.single': { data: { id: 'run-1' } },
        'projects.maybeSingle': {}, // unused
        'projects.single': {},
      },
      [
        { summary: { stars: 10, forks: 2, watchers: 3 } },
        { summary: { stars: 5, forks: 1, watchers: 1 } },
      ]
    )
    // The projects SELECT resolves via .then — register it.
    ;(deps.admin as unknown as { from: (t: string) => unknown }).from =
      withProjectSelect(deps.admin, PROJECT_ROWS, 'run-1')

    const summary = await runCapture(deps)

    expect(summary.status).toBe('success')
    expect(summary.reposOk).toBe(2)
    expect(summary.reposFailed).toBe(0)
    expect(summary.advancedWatchdogClock).toBe(true)

    const close = ops.find(
      (o) => o.table === 'capture_runs' && o.op === 'update'
    )
    expect(close).toBeDefined()
    const patch = close!.payload as Record<string, unknown>
    expect(patch.status).toBe('success')
    expect(patch.last_successful_capture_at).toBeDefined()
    expect(patch.last_successful_capture_at).toBe(patch.finished_at)
  })

  it('does NOT advance the clock when one repo fails (partial run)', async () => {
    const { deps, ops, seenSignals } = depsFor({}, [
      { summary: { stars: 10, forks: 2, watchers: 3 } },
      { throwOn: 'summary' }, // p2 blows up in the worker
    ])
    ;(deps.admin as unknown as { from: (t: string) => unknown }).from =
      withProjectSelect(deps.admin, PROJECT_ROWS, 'run-1')

    const summary = await runCapture(deps)

    expect(summary.status).toBe('partial')
    expect(summary.reposOk).toBe(1)
    expect(summary.reposFailed).toBe(1)
    expect(summary.advancedWatchdogClock).toBe(false)

    const close = ops.find(
      (o) => o.table === 'capture_runs' && o.op === 'update'
    )!
    const patch = close.payload as Record<string, unknown>
    expect(patch.status).toBe('partial')
    // The crucial invariant: a partial run must NOT reset the watchdog clock.
    expect(patch.last_successful_capture_at).toBeUndefined()
    expect(patch.error).toContain('1/2 repos failed')

    // Both repos were still attempted (envelope isolation), and a signal was
    // threaded into each client build.
    expect(seenSignals.length).toBeGreaterThanOrEqual(2)
  })

  it('records a success run with NO clock advance when the tracked list is empty', async () => {
    const { deps, ops } = depsFor({}, [])
    ;(deps.admin as unknown as { from: (t: string) => unknown }).from =
      withProjectSelect(deps.admin, [], 'run-1')

    const summary = await runCapture(deps)

    expect(summary.status).toBe('success')
    expect(summary.reposTotal).toBe(0)
    expect(summary.advancedWatchdogClock).toBe(false)
    const close = ops.find(
      (o) => o.table === 'capture_runs' && o.op === 'update'
    )!
    expect(
      (close.payload as Record<string, unknown>).last_successful_capture_at
    ).toBeUndefined()
  })
})

describe('runCapture — window uniques persisted, never summed (KTD1)', () => {
  it('writes the WINDOW total into traffic_window, distinct from the daily sum', async () => {
    const viewsDays: TDay[] = [
      { day: '2026-06-01', count: 5, uniques: 4 },
      { day: '2026-06-02', count: 7, uniques: 5 },
      { day: '2026-06-03', count: 3, uniques: 3 },
    ]
    // Sum of daily uniques = 12, but the WINDOW uniques is 9 (non-additive).
    const { deps, ops } = depsFor({}, [
      {
        summary: { stars: 1, forks: 0, watchers: 0 },
        views: { windowCount: 15, windowUniques: 9, days: viewsDays },
      },
    ])
    ;(deps.admin as unknown as { from: (t: string) => unknown }).from =
      withProjectSelect(deps.admin, [PROJECT_ROWS[0]], 'run-1')

    await runCapture(deps)

    const windowInsert = ops.find(
      (o) => o.table === 'traffic_window' && o.op === 'insert'
    )
    expect(windowInsert).toBeDefined()
    const row = windowInsert!.payload as Record<string, unknown>
    expect(row.metric).toBe('views')
    expect(row.uniques).toBe(9) // window total — NOT 12 (the daily sum)
    expect(row.count).toBe(15)
    expect(row.window_start).toBe('2026-06-01')
    expect(row.window_end).toBe('2026-06-03')

    // And the daily rows are written under the same repo/metric.
    const dailyUpsert = ops.find(
      (o) => o.table === 'traffic_daily' && o.op === 'upsert'
    )!
    const dailyRows = dailyUpsert.payload as Array<Record<string, unknown>>
    const sumDailyUniques = dailyRows.reduce(
      (acc, r) => acc + (r.uniques as number),
      0
    )
    expect(sumDailyUniques).toBe(12) // proves the two are genuinely different
  })
})

describe('runCapture — traffic_daily self-healing upsert (KTD1, R4)', () => {
  it('upserts ON CONFLICT (repo, metric, day)', async () => {
    const days: TDay[] = [
      { day: '2026-06-01', count: 2, uniques: 2 },
      { day: '2026-06-02', count: 4, uniques: 3 },
    ]
    const { deps, ops } = depsFor({}, [
      {
        summary: { stars: 0, forks: 0, watchers: 0 },
        clones: { windowCount: 6, windowUniques: 4, days },
      },
    ])
    ;(deps.admin as unknown as { from: (t: string) => unknown }).from =
      withProjectSelect(deps.admin, [PROJECT_ROWS[0]], 'run-1')

    await runCapture(deps)

    const upsert = ops.find(
      (o) => o.table === 'traffic_daily' && o.op === 'upsert'
    )!
    expect(upsert.onConflict).toBe('repo,metric,day')
    const rows = upsert.payload as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0].repo).toBe('phdemotions/citegeist')
    expect(rows[0].metric).toBe('clones')
  })
})

describe('runCapture — download span marker on a gap > 1 day (KTD1 / U8)', () => {
  it('writes a downloads_span_days marker when the previous snapshot is stale', async () => {
    // Previous download snapshot was 5 days ago → span 5 → marker expected.
    const fiveDaysAgo = '2026-06-05T07:00:00.000Z'
    const { deps, ops } = depsFor(
      { 'signal_snapshots.maybeSingle': { data: { captured_at: fiveDaysAgo } } },
      [
        {
          summary: { stars: 0, forks: 0, watchers: 0 },
          releases: [{ assets: [{ downloadCount: 100 }, { downloadCount: 50 }] }],
        },
      ]
    )
    ;(deps.admin as unknown as { from: (t: string) => unknown }).from =
      withProjectSelect(deps.admin, [PROJECT_ROWS[0]], 'run-1')

    await runCapture(deps)

    const snapInserts = ops.filter(
      (o) => o.table === 'signal_snapshots' && o.op === 'insert'
    )
    const allRows = snapInserts.flatMap((o) =>
      Array.isArray(o.payload) ? o.payload : [o.payload]
    ) as Array<Record<string, unknown>>

    const downloads = allRows.find((r) => r.metric === 'downloads')
    expect(downloads).toBeDefined()
    expect(downloads!.value).toBe(150) // 100 + 50 summed across assets

    const marker = allRows.find((r) => r.metric === 'downloads_span_days')
    expect(marker).toBeDefined()
    expect(marker!.value).toBe(5)
  })

  it('writes NO span marker on the first snapshot (no prior)', async () => {
    const { deps, ops } = depsFor(
      { 'signal_snapshots.maybeSingle': { data: null } },
      [
        {
          summary: { stars: 0, forks: 0, watchers: 0 },
          releases: [{ assets: [{ downloadCount: 10 }] }],
        },
      ]
    )
    ;(deps.admin as unknown as { from: (t: string) => unknown }).from =
      withProjectSelect(deps.admin, [PROJECT_ROWS[0]], 'run-1')

    await runCapture(deps)

    const allRows = ops
      .filter((o) => o.table === 'signal_snapshots' && o.op === 'insert')
      .flatMap((o) => (Array.isArray(o.payload) ? o.payload : [o.payload])) as Array<
      Record<string, unknown>
    >
    expect(allRows.find((r) => r.metric === 'downloads_span_days')).toBeUndefined()
  })
})

describe('runCapture — stars/forks appended idempotently', () => {
  it('upserts stars with ignoreDuplicates and only rows carrying starred_at', async () => {
    const { deps, ops } = depsFor({}, [
      {
        summary: { stars: 0, forks: 0, watchers: 0 },
        stargazers: [
          { login: 'alice', starredAt: '2026-01-01T00:00:00Z' },
          { login: 'bob', starredAt: null }, // dropped (no timestamp)
        ],
        forks: [
          { fullName: 'someone/citegeist-fork', createdAt: '2026-02-01T00:00:00Z' },
          { fullName: '', createdAt: '2026-02-02T00:00:00Z' }, // dropped (no name)
        ],
      },
    ])
    ;(deps.admin as unknown as { from: (t: string) => unknown }).from =
      withProjectSelect(deps.admin, [PROJECT_ROWS[0]], 'run-1')

    await runCapture(deps)

    const starUpsert = ops.find((o) => o.table === 'stars' && o.op === 'upsert')!
    expect(starUpsert.onConflict).toBe('repo,github_user')
    expect(starUpsert.ignoreDuplicates).toBe(true)
    const starRows = starUpsert.payload as Array<Record<string, unknown>>
    expect(starRows).toHaveLength(1)
    expect(starRows[0].github_user).toBe('alice')

    const forkUpsert = ops.find((o) => o.table === 'forks' && o.op === 'upsert')!
    expect(forkUpsert.onConflict).toBe('repo,fork_id')
    expect(forkUpsert.ignoreDuplicates).toBe(true)
    const forkRows = forkUpsert.payload as Array<Record<string, unknown>>
    expect(forkRows).toHaveLength(1)
    expect(typeof forkRows[0].fork_id).toBe('number')
  })
})

describe('runCapture — AbortSignal threaded into the client (KTD3)', () => {
  it('passes deps.signal into makeClient for the worker', async () => {
    const controller = new AbortController()
    const { deps, seenSignals } = depsFor(
      {},
      [{ summary: { stars: 0, forks: 0, watchers: 0 } }],
      controller.signal
    )
    ;(deps.admin as unknown as { from: (t: string) => unknown }).from =
      withProjectSelect(deps.admin, [PROJECT_ROWS[0]], 'run-1')

    await runCapture(deps)

    // The worker built a client with the abort signal.
    expect(seenSignals).toContain(controller.signal)
  })
})

describe('pure helpers', () => {
  it('spanDaysSince returns 0 with no prior snapshot', () => {
    expect(spanDaysSince(null, FIXED_NOW)).toBe(0)
  })
  it('spanDaysSince rounds a multi-day gap up', () => {
    expect(
      spanDaysSince('2026-06-05T07:00:00.000Z', '2026-06-10T07:00:00.000Z')
    ).toBe(5)
  })
  it('spanDaysSince returns 0 when the prior is in the future or equal', () => {
    expect(spanDaysSince(FIXED_NOW, FIXED_NOW)).toBe(0)
    expect(
      spanDaysSince('2026-06-11T00:00:00.000Z', FIXED_NOW)
    ).toBe(0)
  })
  it('stableForkId is deterministic and positive within safe-int range', () => {
    const a = stableForkId('owner/repo')
    const b = stableForkId('owner/repo')
    const c = stableForkId('owner/other')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toBeGreaterThan(0)
    expect(Number.isSafeInteger(a)).toBe(true)
  })
})

// ── Helper: wire the projects SELECT + capture_runs open to resolve correctly,
//    while still recording ops via the underlying fake. ─────────────────────────

function withProjectSelect(
  admin: CaptureDeps['admin'],
  projectRows: Array<{ id: string; owner: string; repo: string }>,
  runId: string
): (table: string) => unknown {
  const original = (admin as unknown as { from: (t: string) => unknown }).from.bind(
    admin
  )
  return (table: string) => {
    const chain = original(table) as Record<string, unknown>
    if (table === 'projects') {
      // projects.select(...).eq(...).is(...) is awaited directly → resolve rows.
      chain.then = (
        onFulfilled: (v: { data: unknown; error: unknown }) => unknown
      ) => Promise.resolve({ data: projectRows, error: null }).then(onFulfilled)
    }
    if (table === 'capture_runs') {
      // capture_runs.insert(...).select('id').single() → resolve the run id.
      const realSingle = chain.single as () => Promise<unknown>
      chain.single = () =>
        Promise.resolve({ data: { id: runId }, error: null })
      void realSingle
    }
    return chain
  }
}
