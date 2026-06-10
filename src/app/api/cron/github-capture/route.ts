/**
 * Minimal self-healing GitHub capture cron — U4 (R1, R2, R4, R6, R7; KTD1,
 * KTD3, KTD10).
 *
 * The headless loop that stops perishable GitHub data from being lost. Runs
 * daily (Vercel Cron, see vercel.json). For each tracked project it:
 *   1. reads the repo summary (stars / forks / watchers — KTD8 watchers from
 *      subscribers_count, handled by the client),
 *   2. pulls the FULL 14-day traffic window for views + clones and upserts ALL
 *      14 days into traffic_daily ON CONFLICT (repo, metric, day) DO UPDATE — so
 *      a same-day re-run overwrites and a gap of up to 14 days self-heals on the
 *      next run; data is lost only after 14 consecutive dark days (KTD1, R4),
 *   3. persists the window-level {count, uniques} into traffic_window — window
 *      uniques are NON-ADDITIVE and must never be summed from the daily rows
 *      (KTD1),
 *   4. upserts the current top referrers into traffic_referrers,
 *   5. snapshots the cumulative release download_count into signal_snapshots;
 *      when the gap since the previous download snapshot exceeds one day it also
 *      records a `downloads_span_days` marker row so the derived layer (U8) does
 *      not read a merged multi-day delta as a single-day spike,
 *   6. snapshots cumulative stars / forks / watchers counts into
 *      signal_snapshots, and appends any NEW timestamped stars / forks into the
 *      backfillable event logs.
 *
 * Trust + safety boundary (KTD10):
 *   - GET only; bearer compared with `crypto.timingSafeEqual` against
 *     CRON_SECRET → 401 on mismatch, no work done.
 *   - CAPTURE_ENABLED must be exactly `true`; otherwise a no-op 200 (default OFF
 *     until U0 ops verify).
 *   - Writes go through the service-role admin client (server-only-guarded).
 *   - runtime=nodejs (crypto + service-role), dynamic=force-dynamic (never
 *     cached), maxDuration=800 (requires Fluid Compute — see U0).
 *
 * Bounded + budgeted (KTD3):
 *   - Concurrency is bounded by `runBounded(projects, CAPTURE_CONCURRENCY)`; the
 *     worker closure threads the AbortController signal into the GitHubClient, so
 *     an unbounded Promise.all can never be the scaling cliff.
 *   - An AbortController fires abort() at ABORT_BUDGET_MS (~770s) — headroom
 *     under the 800s ceiling so the final capture_runs / window writes still
 *     flush. Re-derived from the cited learning's 55/60s ratio, not copied.
 *   - The route inspects the per-repo envelope, records success/failure into
 *     capture_runs, and advances last_successful_capture_at ONLY when the whole
 *     batch is all-ok — a partial-failure run does not reset the watchdog clock.
 *
 * Mirrors `fourposts/site/app/api/cron/rate-limit-cleanup/route.ts` (bearer gate,
 * runtime/dynamic, Sentry tags) and the runBounded + AbortController budget shape
 * from `summer93/tools/vercel/{lib/game-events.ts,api/cron/push-dispatcher.ts}`.
 */

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { timingSafeEqual } from 'node:crypto'
import * as Sentry from '@sentry/nextjs'

import { getAdmin } from '@/lib/supabase/admin'
import { GitHubClient } from '@/lib/github/client'
import { runBounded, allOk } from '@/lib/capture/runBounded'
import {
  runCapture,
  type CaptureDeps,
  type CaptureSummary,
} from './capture'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 800

const CRON_SECRET = process.env.CRON_SECRET
/** `true` only when the env var is exactly the string "true" (default OFF). */
const CAPTURE_ENABLED = process.env.CAPTURE_ENABLED === 'true'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN

/** Bounded concurrency across tracked repos (KTD3). Small + steady. */
const CAPTURE_CONCURRENCY = 4

/**
 * Abort the run at ~770s, leaving headroom under maxDuration=800 for the final
 * capture_runs / traffic_window writes to flush. (Not a copy of summer93's 55s
 * — re-derived to the same ~96% ratio against this route's 800s ceiling.)
 */
const ABORT_BUDGET_MS = 770_000

/**
 * Constant-time bearer comparison. `timingSafeEqual` throws on length-mismatched
 * buffers, so we guard length first (a length difference is already a mismatch)
 * and compare equal-length buffers otherwise — no early-exit timing leak.
 */
function bearerMatches(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false
  const expected = `Bearer ${secret}`
  const a = Buffer.from(authHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(): Promise<NextResponse> {
  // ── Auth gate (KTD10): constant-time bearer compare, 401 + no work on miss ──
  const authHeader = (await headers()).get('authorization')

  if (!CRON_SECRET) {
    // A missing secret in a deployed env is a misconfiguration, not an auth
    // pass. Fail closed (and surface it) rather than running unauthenticated.
    Sentry.captureMessage('github-capture cron missing CRON_SECRET', {
      level: 'error',
      tags: { action: 'capture', phase: 'config' },
    })
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 })
  }

  if (!bearerMatches(authHeader, CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ── Feature gate (KTD10): default OFF until U0 ops verify ──────────────────
  if (!CAPTURE_ENABLED) {
    return NextResponse.json({ ok: true, skipped: 'capture_disabled' })
  }

  if (!GITHUB_TOKEN) {
    // env.ts already requires this when CAPTURE_ENABLED=true, but guard at the
    // call site too so a misconfigured deploy fails loud rather than throwing
    // deep inside a worker.
    Sentry.captureMessage('github-capture enabled but GITHUB_TOKEN missing', {
      level: 'error',
      tags: { action: 'capture', phase: 'config' },
    })
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 })
  }

  // ── Abort budget (KTD3): fire at ~770s, leave headroom for final flushes ───
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), ABORT_BUDGET_MS)

  try {
    const token = GITHUB_TOKEN
    const deps: CaptureDeps = {
      admin: getAdmin(),
      signal: controller.signal,
      // The worker owns threading the abort signal into the client (KTD3).
      makeClient: (signal) => new GitHubClient({ token, signal }),
      runBounded,
      allOk,
      concurrency: CAPTURE_CONCURRENCY,
      now: () => new Date(),
    }

    const summary: CaptureSummary = await runCapture(deps)
    return NextResponse.json(summary, {
      status: summary.status === 'error' ? 500 : 200,
    })
  } catch (err) {
    // Top-level safety net. Per-repo failures are already isolated by the
    // envelope inside runCapture; reaching here means the orchestration itself
    // failed (e.g. the capture_runs insert).
    Sentry.captureException(err, {
      tags: { action: 'capture', phase: 'unexpected' },
    })
    return NextResponse.json({ error: 'capture_failed' }, { status: 500 })
  } finally {
    clearTimeout(abortTimer)
  }
}
