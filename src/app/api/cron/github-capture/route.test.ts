import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * U4 capture-route tests (KTD3, KTD10). Test-first for the AUTH GATE and the
 * route's contract with the capture core. No live secrets, no live GitHub, no
 * live Supabase — every boundary (`next/headers`, the admin client, the
 * GitHubClient, and the capture orchestration) is mocked.
 *
 * What this file pins:
 *   • wrong / missing bearer → 401 and NO work done;
 *   • a config error (deployed env without CRON_SECRET) → 500 (fails closed);
 *   • CAPTURE_ENABLED !== "true" → no-op 200, runCapture never called;
 *   • a valid call threads a REAL AbortSignal into the client factory (KTD3) and
 *     returns the capture summary with the right HTTP status.
 *
 * Deeper envelope / watchdog / idempotency assertions live in capture.test.ts
 * (the testable core); this file owns the gate + wiring.
 */

// ── Mock the module boundary. next/headers + the admin client + the GitHub
//    client are replaced; runCapture is a spy so we can assert the route's
//    wiring without exercising the whole pipeline here. ────────────────────────

const headerStore = { authorization: null as string | null }

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) =>
      name.toLowerCase() === 'authorization' ? headerStore.authorization : null,
  }),
}))

const getAdminMock = vi.fn(() => ({ __admin: true }))
vi.mock('@/lib/supabase/admin', () => ({
  getAdmin: () => getAdminMock(),
}))

const gitHubClientCtor = vi.fn()
vi.mock('@/lib/github/client', () => ({
  GitHubClient: class {
    constructor(opts: unknown) {
      gitHubClientCtor(opts)
    }
  },
}))

const runCaptureMock = vi.fn()
vi.mock('./capture', () => ({
  runCapture: (...args: unknown[]) => runCaptureMock(...args),
}))

const sentryCapture = vi.fn()
const sentryMessage = vi.fn()
vi.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => sentryCapture(...a),
  captureMessage: (...a: unknown[]) => sentryMessage(...a),
}))

const ORIGINAL_ENV = { ...process.env }

/**
 * Import the route fresh after setting env, because the module reads
 * CRON_SECRET / CAPTURE_ENABLED / GITHUB_TOKEN at module-eval time.
 */
async function loadRoute() {
  vi.resetModules()
  // Re-establish the mocks for the fresh module graph.
  vi.doMock('next/headers', () => ({
    headers: async () => ({
      get: (name: string) =>
        name.toLowerCase() === 'authorization'
          ? headerStore.authorization
          : null,
    }),
  }))
  vi.doMock('@/lib/supabase/admin', () => ({ getAdmin: () => getAdminMock() }))
  vi.doMock('@/lib/github/client', () => ({
    GitHubClient: class {
      constructor(opts: unknown) {
        gitHubClientCtor(opts)
      }
    },
  }))
  vi.doMock('./capture', () => ({
    runCapture: (...args: unknown[]) => runCaptureMock(...args),
  }))
  vi.doMock('@sentry/nextjs', () => ({
    captureException: (...a: unknown[]) => sentryCapture(...a),
    captureMessage: (...a: unknown[]) => sentryMessage(...a),
  }))
  return import('./route')
}

const OK_SUMMARY = {
  status: 'success' as const,
  runId: 'run-1',
  reposTotal: 2,
  reposOk: 2,
  reposFailed: 0,
  advancedWatchdogClock: true,
  finishedAt: '2026-06-10T07:05:00.000Z',
}

beforeEach(() => {
  headerStore.authorization = null
  getAdminMock.mockClear()
  gitHubClientCtor.mockClear()
  runCaptureMock.mockReset()
  runCaptureMock.mockResolvedValue(OK_SUMMARY)
  sentryCapture.mockClear()
  sentryMessage.mockClear()
  process.env = { ...ORIGINAL_ENV }
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('auth gate (KTD10)', () => {
  it('returns 401 and does NO work on a wrong bearer', async () => {
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    process.env.CAPTURE_ENABLED = 'true'
    process.env.GITHUB_TOKEN = 'github_pat_x'
    headerStore.authorization = 'Bearer the-wrong-secret-value-here'

    const { GET } = await loadRoute()
    const res = await GET()

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' })
    expect(runCaptureMock).not.toHaveBeenCalled()
    expect(getAdminMock).not.toHaveBeenCalled()
    expect(gitHubClientCtor).not.toHaveBeenCalled()
  })

  it('returns 401 when the Authorization header is missing entirely', async () => {
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    process.env.CAPTURE_ENABLED = 'true'
    process.env.GITHUB_TOKEN = 'github_pat_x'
    headerStore.authorization = null

    const { GET } = await loadRoute()
    const res = await GET()

    expect(res.status).toBe(401)
    expect(runCaptureMock).not.toHaveBeenCalled()
  })

  it('returns 401 on a same-prefix-but-shorter bearer (length-guarded compare)', async () => {
    // timingSafeEqual throws on unequal-length buffers; the route guards length
    // first. A truncated-but-prefix-matching token must still be rejected.
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    process.env.CAPTURE_ENABLED = 'true'
    process.env.GITHUB_TOKEN = 'github_pat_x'
    headerStore.authorization = 'Bearer a-sufficiently-long-cron-secr' // 1 char short

    const { GET } = await loadRoute()
    const res = await GET()

    expect(res.status).toBe(401)
    expect(runCaptureMock).not.toHaveBeenCalled()
  })

  it('fails closed with 500 when CRON_SECRET is unset in a deployed env', async () => {
    delete process.env.CRON_SECRET
    process.env.CAPTURE_ENABLED = 'true'
    headerStore.authorization = 'Bearer anything'

    const { GET } = await loadRoute()
    const res = await GET()

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'misconfigured' })
    expect(runCaptureMock).not.toHaveBeenCalled()
    expect(sentryMessage).toHaveBeenCalledOnce()
  })
})

describe('feature gate (KTD10 — CAPTURE_ENABLED default OFF)', () => {
  it('no-ops with 200 when CAPTURE_ENABLED is not "true"', async () => {
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    process.env.CAPTURE_ENABLED = 'false'
    headerStore.authorization = 'Bearer a-sufficiently-long-cron-secret'

    const { GET } = await loadRoute()
    const res = await GET()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      skipped: 'capture_disabled',
    })
    expect(runCaptureMock).not.toHaveBeenCalled()
    expect(getAdminMock).not.toHaveBeenCalled()
  })

  it('treats an absent CAPTURE_ENABLED as OFF', async () => {
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    delete process.env.CAPTURE_ENABLED
    headerStore.authorization = 'Bearer a-sufficiently-long-cron-secret'

    const { GET } = await loadRoute()
    const res = await GET()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      skipped: 'capture_disabled',
    })
    expect(runCaptureMock).not.toHaveBeenCalled()
  })

  it('returns 500 when capture is enabled but GITHUB_TOKEN is missing', async () => {
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    process.env.CAPTURE_ENABLED = 'true'
    delete process.env.GITHUB_TOKEN
    headerStore.authorization = 'Bearer a-sufficiently-long-cron-secret'

    const { GET } = await loadRoute()
    const res = await GET()

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'misconfigured' })
    expect(runCaptureMock).not.toHaveBeenCalled()
    expect(sentryMessage).toHaveBeenCalledOnce()
  })
})

describe('valid run wiring (KTD3)', () => {
  it('runs capture and threads a real AbortSignal into the client factory', async () => {
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    process.env.CAPTURE_ENABLED = 'true'
    process.env.GITHUB_TOKEN = 'github_pat_realish'
    headerStore.authorization = 'Bearer a-sufficiently-long-cron-secret'

    const { GET } = await loadRoute()
    const res = await GET()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(OK_SUMMARY)
    expect(runCaptureMock).toHaveBeenCalledOnce()

    // The deps handed to runCapture must carry the admin client, a bounded
    // concurrency, a clock, and a makeClient factory that — when invoked —
    // threads an AbortSignal into the GitHubClient (KTD3).
    const deps = runCaptureMock.mock.calls[0][0]
    expect(deps.admin).toEqual({ __admin: true })
    expect(typeof deps.concurrency).toBe('number')
    expect(deps.concurrency).toBeGreaterThanOrEqual(1)
    expect(deps.signal).toBeInstanceOf(AbortSignal)
    expect(typeof deps.makeClient).toBe('function')
    expect(typeof deps.now).toBe('function')

    // Invoking the factory the way the worker does must construct a client with
    // the threaded signal + the token (never a hardcoded/missing one).
    deps.makeClient(deps.signal)
    expect(gitHubClientCtor).toHaveBeenCalledOnce()
    const clientOpts = gitHubClientCtor.mock.calls[0][0]
    expect(clientOpts.token).toBe('github_pat_realish')
    expect(clientOpts.signal).toBe(deps.signal)
  })

  it('propagates a non-success capture status to the HTTP status', async () => {
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    process.env.CAPTURE_ENABLED = 'true'
    process.env.GITHUB_TOKEN = 'github_pat_x'
    headerStore.authorization = 'Bearer a-sufficiently-long-cron-secret'

    runCaptureMock.mockResolvedValue({ ...OK_SUMMARY, status: 'error' })

    const { GET } = await loadRoute()
    const res = await GET()
    expect(res.status).toBe(500)
  })

  it('a partial capture still returns 200 (the run completed, some repos failed)', async () => {
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    process.env.CAPTURE_ENABLED = 'true'
    process.env.GITHUB_TOKEN = 'github_pat_x'
    headerStore.authorization = 'Bearer a-sufficiently-long-cron-secret'

    runCaptureMock.mockResolvedValue({
      ...OK_SUMMARY,
      status: 'partial',
      reposOk: 1,
      reposFailed: 1,
      advancedWatchdogClock: false,
    })

    const { GET } = await loadRoute()
    const res = await GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'partial' })
  })

  it('catches an orchestration throw → 500 + Sentry with capture tags', async () => {
    process.env.CRON_SECRET = 'a-sufficiently-long-cron-secret'
    process.env.CAPTURE_ENABLED = 'true'
    process.env.GITHUB_TOKEN = 'github_pat_x'
    headerStore.authorization = 'Bearer a-sufficiently-long-cron-secret'

    runCaptureMock.mockRejectedValue(new Error('capture_runs insert failed'))

    const { GET } = await loadRoute()
    const res = await GET()

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'capture_failed' })
    expect(sentryCapture).toHaveBeenCalledOnce()
    const tags = sentryCapture.mock.calls[0][1]
    expect(tags).toMatchObject({ tags: { action: 'capture' } })
  })
})
