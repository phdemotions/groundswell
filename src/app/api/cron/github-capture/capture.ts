/**
 * Capture orchestration — the testable core of U4 (KTD1, KTD3).
 *
 * Split out of `route.ts` so the bounded-fan-out + idempotent-upsert + envelope
 * logic is unit-testable with injected dependencies (admin client, client
 * factory, limiter, clock) and NO live GitHub/Supabase calls — the same shape as
 * summer93's `runDispatcher`. `route.ts` owns only the Next route-segment config,
 * the auth/feature gates, and the AbortController budget; it calls `runCapture`
 * with production dependencies.
 *
 * Dependency seam (`CaptureDeps`): everything that touches the outside world is
 * injected. The worker receives a `makeClient(signal)` factory so it OWNS
 * threading the abort signal into the GitHubClient (KTD3) — abort threading lives
 * with the I/O, never with the scheduler.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'

import type { Database } from '@/types/database'
import type { GitHubClient } from '@/lib/github/client'
import type { BoundedResult } from '@/lib/capture/runBounded'

type Admin = SupabaseClient<Database>

/** The capture-time view of a tracked project (one row of `projects`). */
export interface TrackedProject {
  id: string
  owner: string
  repo: string
}

/** Per-repo result rolled up from the worker; written into capture_runs. */
export interface RepoCaptureResult {
  /** "owner/repo" slug. */
  repo: string
  trafficDaysUpserted: number
  windowsUpserted: number
  referrersUpserted: number
  downloadSnapshots: number
  spanMarkers: number
  starsAppended: number
  forksAppended: number
}

export interface CaptureSummary {
  status: 'success' | 'partial' | 'error'
  runId: string | null
  reposTotal: number
  reposOk: number
  reposFailed: number
  /** True only when last_successful_capture_at was advanced this run (all-ok). */
  advancedWatchdogClock: boolean
  finishedAt: string
}

/**
 * The injectable factory the worker uses to build a per-repo client with the
 * abort signal already threaded in (KTD3).
 */
export type ClientFactory = (signal: AbortSignal | undefined) => GitHubClient

/** The limiter signature (matches `runBounded`). Injected for testability. */
export type RunBounded = <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
) => Promise<Array<BoundedResult<R>>>

export interface CaptureDeps {
  admin: Admin
  signal: AbortSignal | undefined
  makeClient: ClientFactory
  runBounded: RunBounded
  allOk: <R>(results: ReadonlyArray<BoundedResult<R>>) => boolean
  concurrency: number
  now: () => Date
}

/** Data-availability classes (mirror src/types/database.ts DataClass). */
const DATA_CLASS = {
  cumulative: 'cumulative',
  rollingWindow: 'rolling_window',
} as const

const SOURCE_GITHUB = 'github'

/** One day in ms — gap threshold for the download span-marker (KTD1 / U8). */
const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Run the full capture. Selects tracked projects, fans out the per-repo worker
 * with bounded concurrency, inspects the envelope, writes per-repo telemetry to
 * capture_runs, and advances last_successful_capture_at ONLY when every repo
 * succeeded.
 */
export async function runCapture(deps: CaptureDeps): Promise<CaptureSummary> {
  const startedAt = deps.now().toISOString()

  // ── Open a capture_runs row (status 'running'). ───────────────────────────
  const runId = await openCaptureRun(deps, startedAt)

  // ── Select the tracked, non-deleted projects. ─────────────────────────────
  const projects = await selectTrackedProjects(deps)

  if (projects.length === 0) {
    // Nothing to capture is a vacuously-successful run, but with no repos there
    // is no fresh data — do NOT advance the watchdog clock (advancing it on an
    // empty roster would mask a genuinely-empty tracked list).
    const finishedAt = deps.now().toISOString()
    await closeCaptureRun(deps, runId, {
      status: 'success',
      finishedAt,
      advanceClock: false,
      error: null,
    })
    return {
      status: 'success',
      runId,
      reposTotal: 0,
      reposOk: 0,
      reposFailed: 0,
      advancedWatchdogClock: false,
      finishedAt,
    }
  }

  // ── Bounded fan-out. The worker closure threads the abort signal into the
  //    client (KTD3); a single repo's failure is captured in the envelope and
  //    does not abort the batch. ─────────────────────────────────────────────
  const results = await deps.runBounded(
    projects,
    deps.concurrency,
    (project) => captureOneRepo(deps, project)
  )

  const reposOk = results.filter((r) => r.ok).length
  const reposFailed = results.length - reposOk
  const batchAllOk = deps.allOk(results)

  // ── Record per-repo failures to Sentry (the envelope keeps them off the
  //    throw path, so surface them explicitly). ──────────────────────────────
  results.forEach((r, i) => {
    if (!r.ok) {
      const project = projects[i]
      Sentry.captureException(r.error, {
        tags: {
          action: 'capture',
          phase: 'repo',
          repo: `${project.owner}/${project.repo}`,
        },
      })
    }
  })

  const finishedAt = deps.now().toISOString()
  const status: CaptureSummary['status'] = batchAllOk ? 'success' : 'partial'

  // ── Advance the watchdog clock ONLY on an all-ok batch (KTD3). A partial
  //    run leaves last_successful_capture_at untouched so the >10-day watchdog
  //    still trips if failures persist. ───────────────────────────────────────
  await closeCaptureRun(deps, runId, {
    status,
    finishedAt,
    advanceClock: batchAllOk,
    error: batchAllOk ? null : `${reposFailed}/${results.length} repos failed`,
  })

  return {
    status,
    runId,
    reposTotal: results.length,
    reposOk,
    reposFailed,
    advancedWatchdogClock: batchAllOk,
    finishedAt,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Per-repo worker — all v1 signals for ONE repo. Throws on failure so the
// envelope captures it; the route never sees a single repo's error.
// ════════════════════════════════════════════════════════════════════════════

async function captureOneRepo(
  deps: CaptureDeps,
  project: TrackedProject
): Promise<RepoCaptureResult> {
  const repo = `${project.owner}/${project.repo}`
  // The worker OWNS threading the abort signal into the client (KTD3).
  const client = deps.makeClient(deps.signal)
  const capturedAt = deps.now().toISOString()

  const result: RepoCaptureResult = {
    repo,
    trafficDaysUpserted: 0,
    windowsUpserted: 0,
    referrersUpserted: 0,
    downloadSnapshots: 0,
    spanMarkers: 0,
    starsAppended: 0,
    forksAppended: 0,
  }

  // 1. Repo summary — stars / forks / watchers (watchers = subscribers_count,
  //    KTD8, enforced inside the client). Snapshot each as a cumulative signal.
  const summary = await client.getRepoSummary(project.owner, project.repo)
  await insertSnapshots(deps, [
    snapshotRow(project.id, 'stars', summary.stars, capturedAt),
    snapshotRow(project.id, 'forks', summary.forks, capturedAt),
    snapshotRow(project.id, 'watchers', summary.watchers, capturedAt),
  ])

  // 2 + 3. Traffic views + clones — upsert ALL 14 days into traffic_daily
  //        ON CONFLICT (repo, metric, day) DO UPDATE (self-healing, KTD1), and
  //        persist the window-level {count, uniques} into traffic_window (window
  //        uniques are non-additive — captured here, never summed from dailies).
  for (const metric of ['views', 'clones'] as const) {
    const series =
      metric === 'views'
        ? await client.getTrafficViews(project.owner, project.repo)
        : await client.getTrafficClones(project.owner, project.repo)

    if (series.days.length > 0) {
      await upsertTrafficDaily(deps, repo, metric, series.days, capturedAt)
      result.trafficDaysUpserted += series.days.length

      // Window bounds from the day grain (sorted ascending). The window-level
      // uniques come from the dedicated window field, NOT a sum of dailies.
      const sorted = [...series.days].sort((a, b) => a.day.localeCompare(b.day))
      const windowStart = sorted[0].day
      const windowEnd = sorted[sorted.length - 1].day
      await insertTrafficWindow(deps, {
        repo,
        metric,
        window_start: windowStart,
        window_end: windowEnd,
        count: series.windowCount,
        uniques: series.windowUniques,
        captured_at: capturedAt,
      })
      result.windowsUpserted += 1
    }
  }

  // 4. Referrers — current top sources, stamped with today's UTC day, upserted
  //    (repo, referrer, day) so a same-day re-run overwrites (KTD1).
  const referrers = await client.getReferrers(project.owner, project.repo)
  if (referrers.length > 0) {
    const day = capturedAt.slice(0, 10)
    await upsertReferrers(deps, repo, day, referrers, capturedAt)
    result.referrersUpserted += referrers.length
  }

  // 5. Releases — snapshot the cumulative download_count across all assets.
  //    download_count has no native history, so we snapshot it each run and the
  //    derived layer diffs. If the gap since the previous download snapshot
  //    exceeds one day, also write a span-days marker so U8 smoothing does not
  //    read a merged multi-day delta as a single-day spike (KTD1).
  const releases = await client.listReleases(project.owner, project.repo)
  const totalDownloads = sumDownloads(releases)
  const lastSnapshotAt = await lastDownloadSnapshotAt(deps, project.id)
  const spanDays = spanDaysSince(lastSnapshotAt, capturedAt)

  const downloadRows = [
    snapshotRow(project.id, 'downloads', totalDownloads, capturedAt),
  ]
  if (spanDays > 1) {
    // The marker's VALUE is the day-span the next delta covers; the derived
    // layer reads it to attribute the delta across `spanDays` days, not one.
    downloadRows.push(
      snapshotRow(project.id, 'downloads_span_days', spanDays, capturedAt)
    )
    result.spanMarkers += 1
  }
  await insertSnapshots(deps, downloadRows)
  result.downloadSnapshots += 1

  // 6. Append NEW timestamped stars / forks into the backfillable event logs.
  //    Idempotent via the table UNIQUE constraints (ignore-duplicates upsert).
  const stargazers = await client.listStargazers(project.owner, project.repo)
  const starRows = stargazers
    .filter((s) => s.starredAt !== null)
    .map((s) => ({
      repo,
      github_user: s.login,
      starred_at: s.starredAt as string,
      captured_at: capturedAt,
    }))
  if (starRows.length > 0) {
    await appendStars(deps, starRows)
    result.starsAppended += starRows.length
  }

  const forks = await client.listForks(project.owner, project.repo)
  const forkRows = forks
    .filter((f) => f.createdAt !== null && f.fullName.length > 0)
    .map((f) => ({
      repo,
      // GitHub fork id isn't exposed by the parsed ForkEvent; the table keys on
      // (repo, fork_id). Derive a stable numeric id from the fork's full name so
      // the append stays idempotent without re-fetching each fork's numeric id.
      fork_id: stableForkId(f.fullName),
      created_at: f.createdAt as string,
      captured_at: capturedAt,
    }))
  if (forkRows.length > 0) {
    await appendForks(deps, forkRows)
    result.forksAppended += forkRows.length
  }

  return result
}

// ════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ════════════════════════════════════════════════════════════════════════════

function snapshotRow(
  projectId: string,
  metric: string,
  value: number,
  capturedAt: string
): Database['public']['Tables']['signal_snapshots']['Insert'] {
  return {
    project_id: projectId,
    source: SOURCE_GITHUB,
    metric,
    value,
    data_class: DATA_CLASS.cumulative,
    captured_at: capturedAt,
  }
}

function sumDownloads(
  releases: Array<{ assets: Array<{ downloadCount: number }> }>
): number {
  let total = 0
  for (const release of releases) {
    for (const asset of release.assets) total += asset.downloadCount
  }
  return total
}

/** Whole-day span between two ISO timestamps, rounded up; 0 when no prior. */
export function spanDaysSince(
  lastSnapshotAt: string | null,
  capturedAt: string
): number {
  if (lastSnapshotAt === null) return 0
  const last = Date.parse(lastSnapshotAt)
  const now = Date.parse(capturedAt)
  if (Number.isNaN(last) || Number.isNaN(now) || now <= last) return 0
  return Math.ceil((now - last) / ONE_DAY_MS)
}

/**
 * Deterministic positive 53-bit id from a fork's full name. The parsed
 * ForkEvent doesn't carry GitHub's numeric repo id, but the table only needs a
 * STABLE key per (repo, fork) for idempotent appends — the same full name always
 * hashes to the same id, so a re-run never duplicates. FNV-1a, kept well inside
 * Number.MAX_SAFE_INTEGER.
 */
export function stableForkId(fullName: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < fullName.length; i++) {
    hash ^= fullName.charCodeAt(i)
    // FNV prime multiply via shifts to stay in 32-bit range, then widen.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  // Spread into a larger space so collisions across many forks are negligible
  // while staying < 2^53. Combine with the length for extra dispersion.
  return hash * 1000 + (fullName.length % 1000)
}

// ════════════════════════════════════════════════════════════════════════════
// DB access — every call scoped, idempotent where the table is upsert-mutated.
// ════════════════════════════════════════════════════════════════════════════

async function openCaptureRun(
  deps: CaptureDeps,
  startedAt: string
): Promise<string | null> {
  const { data, error } = await deps.admin
    .from('capture_runs')
    .insert({ started_at: startedAt, status: 'running' })
    .select('id')
    .single()
  if (error) throw error
  return data?.id ?? null
}

interface CloseRunArgs {
  status: CaptureSummary['status']
  finishedAt: string
  advanceClock: boolean
  error: string | null
}

async function closeCaptureRun(
  deps: CaptureDeps,
  runId: string | null,
  args: CloseRunArgs
): Promise<void> {
  if (runId === null) return
  const patch: Database['public']['Tables']['capture_runs']['Update'] = {
    status: args.status,
    finished_at: args.finishedAt,
    error: args.error,
  }
  // Advance the watchdog anchor ONLY when told to (all-ok batch, KTD3).
  if (args.advanceClock) patch.last_successful_capture_at = args.finishedAt

  const { error } = await deps.admin
    .from('capture_runs')
    .update(patch)
    .eq('id', runId)
  if (error) throw error
}

async function selectTrackedProjects(
  deps: CaptureDeps
): Promise<TrackedProject[]> {
  const { data, error } = await deps.admin
    .from('projects')
    .select('id, owner, repo')
    .eq('is_tracked', true)
    .is('deleted_at', null)
  if (error) throw error
  return (data ?? []) as TrackedProject[]
}

async function insertSnapshots(
  deps: CaptureDeps,
  rows: Array<Database['public']['Tables']['signal_snapshots']['Insert']>
): Promise<void> {
  if (rows.length === 0) return
  const { error } = await deps.admin.from('signal_snapshots').insert(rows)
  if (error) throw error
}

async function upsertTrafficDaily(
  deps: CaptureDeps,
  repo: string,
  metric: 'views' | 'clones',
  days: Array<{ day: string; count: number; uniques: number }>,
  capturedAt: string
): Promise<void> {
  const rows = days.map((d) => ({
    repo,
    metric,
    day: d.day,
    count: d.count,
    uniques: d.uniques,
    captured_at: capturedAt,
  }))
  // ON CONFLICT (repo, metric, day) DO UPDATE — the self-healing re-upsert. A
  // same-day re-run overwrites; a gap of up to 14 days backfills (KTD1, R4).
  const { error } = await deps.admin
    .from('traffic_daily')
    .upsert(rows, { onConflict: 'repo,metric,day' })
  if (error) throw error
}

async function insertTrafficWindow(
  deps: CaptureDeps,
  row: Database['public']['Tables']['traffic_window']['Insert']
): Promise<void> {
  // One window row per (repo, metric) per capture — append, not upsert: the
  // window total is a point-in-time capture and the derived layer reads the
  // latest. (Window uniques are non-additive; this row is the authoritative
  // window-uniques source, never a sum of traffic_daily.)
  const { error } = await deps.admin.from('traffic_window').insert(row)
  if (error) throw error
}

async function upsertReferrers(
  deps: CaptureDeps,
  repo: string,
  day: string,
  referrers: Array<{ referrer: string; count: number; uniques: number }>,
  capturedAt: string
): Promise<void> {
  const rows = referrers.map((r) => ({
    repo,
    referrer: r.referrer,
    day,
    count: r.count,
    uniques: r.uniques,
    captured_at: capturedAt,
  }))
  const { error } = await deps.admin
    .from('traffic_referrers')
    .upsert(rows, { onConflict: 'repo,referrer,day' })
  if (error) throw error
}

async function lastDownloadSnapshotAt(
  deps: CaptureDeps,
  projectId: string
): Promise<string | null> {
  const { data, error } = await deps.admin
    .from('signal_snapshots')
    .select('captured_at')
    .eq('project_id', projectId)
    .eq('metric', 'downloads')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.captured_at ?? null
}

async function appendStars(
  deps: CaptureDeps,
  rows: Array<Database['public']['Tables']['stars']['Insert']>
): Promise<void> {
  // Idempotent append: a star already logged stays put (ignoreDuplicates keeps
  // the original captured_at).
  const { error } = await deps.admin
    .from('stars')
    .upsert(rows, { onConflict: 'repo,github_user', ignoreDuplicates: true })
  if (error) throw error
}

async function appendForks(
  deps: CaptureDeps,
  rows: Array<Database['public']['Tables']['forks']['Insert']>
): Promise<void> {
  const { error } = await deps.admin
    .from('forks')
    .upsert(rows, { onConflict: 'repo,fork_id', ignoreDuplicates: true })
  if (error) throw error
}
