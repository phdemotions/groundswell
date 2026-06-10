/**
 * One-time (re-runnable) history backfill — U7 (R8; KTD5, KTD7).
 *
 * GOAL: reconstruct the history that makes the cold-start showcase non-empty.
 * GitHub destroys the perishable signals over time, but three signals ARE
 * reconstructable from source history, and this script walks them in full:
 *
 *   • stars        — every stargazer's `starred_at` (via the star+json media
 *                    type), upserted into `stars` keyed (repo, github_user).
 *   • forks        — every fork's `created_at`, upserted into `forks` keyed
 *                    (repo, fork_id).
 *   • ship-cadence — commit + release timestamps over time, bucketed by month
 *                    into a `signal_snapshots` TIMESERIES (source='github',
 *                    metric='ship_cadence', data_class='timeseries').
 *
 * Downloads are NOT backfillable — release `download_count` is a cumulative
 * integer with no history, so the download series can only start at the capture
 * date (U4). This script deliberately never touches downloads.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN — mirrors `src/app/api/cron/github-capture/capture.ts`:
 *
 *   Everything that touches the outside world is INJECTED through `BackfillDeps`
 *   (admin client, a per-repo GitHubClient factory, a sleep, a clock). The pure
 *   logic — row mapping, ship-cadence bucketing, throttle math — is exported and
 *   unit-tested with fakes and NO live GitHub / Supabase. `main()` wires the
 *   production dependencies and is the only part that needs real secrets.
 *
 * IDEMPOTENCY (the U7 contract — re-running inserts no duplicates):
 *   • stars / forks  — `upsert(..., { ignoreDuplicates: true })` on the table's
 *     UNIQUE key. A star/fork already logged stays put; a re-run is a no-op for
 *     it. (Same mechanism as steady-state capture.)
 *   • ship-cadence   — `signal_snapshots` has no unique key (it is an append-only
 *     event spine), so a naive insert WOULD duplicate on re-run. Cadence is a
 *     pure function of the repo's full commit+release history, so we make it
 *     idempotent by REPLACING the derived series: delete this project's existing
 *     `ship_cadence` rows, then insert the freshly recomputed monthly buckets.
 *     Re-running yields byte-identical state.
 *
 * THROTTLE (stay under GitHub's secondary limit, <900 points/min):
 *   Repos are processed SEQUENTIALLY (never a concurrent fan-out — this is the
 *   burst risk the plan flags for U7), and a short fixed delay is awaited between
 *   each REST request so the request rate stays well under the ceiling. The
 *   delay is computed by the pure `throttleDelayMs(maxPointsPerMin)` so the
 *   budget is testable and tunable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POST-GS-001 RUN STEPS (this script needs the dedicated Supabase project + PAT
 * from U0/GS-001 before it can do a live run — see supabase/README.md):
 *
 *   1. Provision the dedicated Supabase project and apply
 *      supabase/migrations/00001_snapshot_model.sql (creates the tables).
 *   2. Seed `projects` with the tracked repos (or run U11 curation first).
 *   3. Export the env this script reads (NEVER commit these):
 *        export NEXT_PUBLIC_SUPABASE_URL=...           # the dedicated project URL
 *        export SUPABASE_SERVICE_ROLE_KEY=...          # service-role key (RLS bypass)
 *        export GITHUB_TOKEN=...                        # fine-grained PAT (KTD5)
 *        export CAPTURE_ENABLED=true                    # explicit opt-in for the live run
 *   4. Run once:
 *        pnpm exec tsx scripts/backfill.ts
 *      (add `--dry-run` to walk GitHub + log the plan without writing.)
 *   5. Re-running is safe and idempotent — it is the recommended way to refresh
 *      the star/fork tail and recompute ship-cadence after more history accrues.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/types/database'
import type { GitHubClient } from '@/lib/github/client'
import type { CommitEvent, ForkEvent, Release, StargazerEvent } from '@/lib/github/types'

type Admin = SupabaseClient<Database>

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const SOURCE_GITHUB = 'github'
const METRIC_SHIP_CADENCE = 'ship_cadence'
/** Ship-cadence is a native point-in-time series we reconstruct (R5). */
const DATA_CLASS_TIMESERIES = 'timeseries'

/**
 * GitHub's secondary-rate-limit ceiling is ~900 points/minute for REST. We stay
 * comfortably UNDER it: this is the budget the throttle is sized against, not a
 * target to hit.
 */
export const SECONDARY_LIMIT_POINTS_PER_MIN = 900

/** A per-request safety margin: aim for this fraction of the ceiling. */
const THROTTLE_SAFETY_FRACTION = 0.5

/** Commit-walk page bound (one repo's history can be long; cap the burst). */
const COMMIT_MAX_PAGES = 50

// ════════════════════════════════════════════════════════════════════════════
// Public types
// ════════════════════════════════════════════════════════════════════════════

/** The backfill view of a tracked project (one row of `projects`). */
export interface BackfillProject {
  id: string
  owner: string
  repo: string
}

/** Per-repo tally rolled up for the run report. */
export interface RepoBackfillResult {
  /** "owner/repo" slug. */
  repo: string
  starsUpserted: number
  forksUpserted: number
  shipCadenceBuckets: number
  /** Total ship events (commits + releases) that fed the cadence series. */
  shipEvents: number
}

export interface BackfillSummary {
  reposTotal: number
  reposOk: number
  reposFailed: number
  results: RepoBackfillResult[]
  /** Per-repo failures, surfaced rather than swallowed. */
  failures: Array<{ repo: string; error: unknown }>
}

/**
 * The injectable factory the backfill uses to build a per-repo client. Mirrors
 * capture's `ClientFactory` so an AbortSignal (if a runner adds a budget) is
 * threaded with the I/O, not the orchestrator.
 */
export type ClientFactory = (signal?: AbortSignal) => GitHubClient

export interface BackfillDeps {
  admin: Admin
  makeClient: ClientFactory
  /** Injectable sleep (defaults to setTimeout in main). Tests pass a spy. */
  sleep: (ms: number) => Promise<void>
  /** Injectable clock. Stamps `captured_at` on stars/forks rows. */
  now: () => Date
  /**
   * Secondary-rate-limit budget (points/min). The inter-request delay is sized
   * from it. Defaults to SECONDARY_LIMIT_POINTS_PER_MIN.
   */
  maxPointsPerMin?: number
  /** When true, walk GitHub + compute, but write nothing. */
  dryRun?: boolean
  /** Optional structured logger (defaults to no-op in tests). */
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

// ════════════════════════════════════════════════════════════════════════════
// Orchestration — sequential per repo (throttled), idempotent writes.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run the full backfill across all tracked, non-deleted projects. Repos are
 * processed SEQUENTIALLY with an inter-request throttle delay (U7 burst risk).
 * A single repo's failure is isolated (recorded in `failures`) and does not
 * abort the run.
 */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillSummary> {
  const log = deps.log ?? (() => {})
  const projects = await selectTrackedProjects(deps)

  const results: RepoBackfillResult[] = []
  const failures: Array<{ repo: string; error: unknown }> = []

  for (const project of projects) {
    const repo = `${project.owner}/${project.repo}`
    try {
      const result = await backfillOneRepo(deps, project)
      results.push(result)
      log('backfill.repo.ok', { ...result })
    } catch (error) {
      failures.push({ repo, error })
      log('backfill.repo.error', { repo, error: String(error) })
    }
  }

  return {
    reposTotal: projects.length,
    reposOk: results.length,
    reposFailed: failures.length,
    results,
    failures,
  }
}

/**
 * Backfill every reconstructable signal for ONE repo. Throws on failure so the
 * caller's per-repo try/catch isolates it. Requests are spaced by the throttle
 * delay to respect the secondary rate limit.
 */
async function backfillOneRepo(
  deps: BackfillDeps,
  project: BackfillProject
): Promise<RepoBackfillResult> {
  const repo = `${project.owner}/${project.repo}`
  const client = deps.makeClient()
  const capturedAt = deps.now().toISOString()
  const delayMs = throttleDelayMs(deps.maxPointsPerMin)
  const dryRun = deps.dryRun === true

  const result: RepoBackfillResult = {
    repo,
    starsUpserted: 0,
    forksUpserted: 0,
    shipCadenceBuckets: 0,
    shipEvents: 0,
  }

  // ── 1. Stars — walk every stargazer, upsert idempotently. ─────────────────
  const stargazers = await client.listStargazers(project.owner, project.repo)
  const starRows = toStarRows(repo, stargazers, capturedAt)
  if (starRows.length > 0 && !dryRun) await appendStars(deps, starRows)
  result.starsUpserted = starRows.length
  await deps.sleep(delayMs)

  // ── 2. Forks — walk every fork, upsert idempotently. ──────────────────────
  const forks = await client.listForks(project.owner, project.repo)
  const forkRows = toForkRows(repo, forks, capturedAt)
  if (forkRows.length > 0 && !dryRun) await appendForks(deps, forkRows)
  result.forksUpserted = forkRows.length
  await deps.sleep(delayMs)

  // ── 3. Ship-cadence — commits + releases bucketed into a monthly timeseries.
  const commits = await client.listCommits(project.owner, project.repo, {
    perPage: 100,
    maxPages: COMMIT_MAX_PAGES,
  })
  await deps.sleep(delayMs)
  const releases = await client.listReleases(project.owner, project.repo)

  const buckets = buildShipCadence(commits, releases)
  result.shipEvents = buckets.reduce((sum, b) => sum + b.value, 0)
  const cadenceRows = toShipCadenceRows(project.id, buckets)

  // Idempotent series replace: delete this project's existing ship_cadence rows,
  // then insert the freshly recomputed buckets (cadence is a pure function of
  // history, so a replace yields identical state on re-run).
  if (!dryRun) await replaceShipCadence(deps, project.id, cadenceRows)
  result.shipCadenceBuckets = cadenceRows.length

  return result
}

// ════════════════════════════════════════════════════════════════════════════
// Pure logic — exported for direct unit testing (no I/O).
// ════════════════════════════════════════════════════════════════════════════

type StarInsert = Database['public']['Tables']['stars']['Insert']
type ForkInsert = Database['public']['Tables']['forks']['Insert']
type SnapshotInsert = Database['public']['Tables']['signal_snapshots']['Insert']

/**
 * Map stargazer events to `stars` insert rows, dropping any without a
 * `starred_at` (the backfill is worthless without the timestamp — never
 * fabricate one). The (repo, github_user) UNIQUE key makes the upsert idempotent.
 */
export function toStarRows(
  repo: string,
  stargazers: StargazerEvent[],
  capturedAt: string
): StarInsert[] {
  return stargazers
    .filter((s) => s.starredAt !== null && s.login.length > 0)
    .map((s) => ({
      repo,
      github_user: s.login,
      starred_at: s.starredAt as string,
      captured_at: capturedAt,
    }))
}

/**
 * Map fork events to `forks` insert rows, dropping any without a `created_at` or
 * full name. The fork's numeric id isn't carried on the parsed event, so a
 * stable id is derived from the full name (same scheme + key as capture), keeping
 * the (repo, fork_id) upsert idempotent.
 */
export function toForkRows(
  repo: string,
  forks: ForkEvent[],
  capturedAt: string
): ForkInsert[] {
  return forks
    .filter((f) => f.createdAt !== null && f.fullName.length > 0)
    .map((f) => ({
      repo,
      fork_id: stableForkId(f.fullName),
      created_at: f.createdAt as string,
      captured_at: capturedAt,
    }))
}

/** One reconstructed ship-cadence bucket: a month and its ship-event count. */
export interface ShipCadenceBucket {
  /** First instant of the month, UTC ISO — the series' time axis. */
  monthStart: string
  /** Number of ship events (commits + releases) in that month. */
  value: number
}

/**
 * Reconstruct ship-cadence from commit + release history. A "ship event" is a
 * commit (by its authored/committer date) OR a release (by its published, else
 * created date). Events are bucketed by calendar month (UTC) and counted, giving
 * a real "actively shipping" curve over time. Buckets are returned sorted
 * ascending by month; empty months are omitted (a gap reads as no shipping, not
 * a fabricated zero).
 */
export function buildShipCadence(
  commits: CommitEvent[],
  releases: Release[]
): ShipCadenceBucket[] {
  const counts = new Map<string, number>()

  const add = (timestamp: string | null): void => {
    const month = monthKey(timestamp)
    if (month === null) return
    counts.set(month, (counts.get(month) ?? 0) + 1)
  }

  for (const commit of commits) add(commit.committedAt)
  for (const release of releases) {
    // A draft release was never shipped — exclude it from the cadence.
    if (release.draft) continue
    add(release.publishedAt ?? release.createdAt)
  }

  return [...counts.entries()]
    .map(([month, value]) => ({ monthStart: `${month}-01T00:00:00.000Z`, value }))
    .sort((a, b) => a.monthStart.localeCompare(b.monthStart))
}

/** Map ship-cadence buckets to `signal_snapshots` timeseries insert rows. */
export function toShipCadenceRows(
  projectId: string,
  buckets: ShipCadenceBucket[]
): SnapshotInsert[] {
  return buckets.map((b) => ({
    project_id: projectId,
    source: SOURCE_GITHUB,
    metric: METRIC_SHIP_CADENCE,
    value: b.value,
    data_class: DATA_CLASS_TIMESERIES,
    captured_at: b.monthStart,
  }))
}

/**
 * The `YYYY-MM` UTC month key from an ISO timestamp, or null when unparseable.
 * Exported so the bucketing contract is directly testable.
 */
export function monthKey(timestamp: string | null): string | null {
  if (typeof timestamp !== 'string' || timestamp.length === 0) return null
  const ms = Date.parse(timestamp)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString().slice(0, 7)
}

/**
 * The inter-request delay (ms) that keeps the request rate under the secondary
 * limit. We target THROTTLE_SAFETY_FRACTION of the ceiling, so e.g. a 900/min
 * ceiling at 50% → 450 effective/min → one request every ~133ms. A non-positive
 * or non-finite budget falls back to the ceiling. Always returns a non-negative
 * integer.
 */
export function throttleDelayMs(
  maxPointsPerMin: number | undefined = SECONDARY_LIMIT_POINTS_PER_MIN
): number {
  const ceiling =
    typeof maxPointsPerMin === 'number' &&
    Number.isFinite(maxPointsPerMin) &&
    maxPointsPerMin > 0
      ? maxPointsPerMin
      : SECONDARY_LIMIT_POINTS_PER_MIN
  const effectivePerMin = ceiling * THROTTLE_SAFETY_FRACTION
  return Math.ceil(60_000 / effectivePerMin)
}

/**
 * Deterministic positive 53-bit id from a fork's full name. The parsed ForkEvent
 * doesn't carry GitHub's numeric repo id, but the (repo, fork_id) table key only
 * needs a STABLE value per fork — the same full name always hashes to the same
 * id, so a backfill re-run never duplicates. MUST match the scheme in
 * `capture.ts` so backfill and steady-state capture agree on the same id for the
 * same fork. FNV-1a, kept well inside Number.MAX_SAFE_INTEGER.
 */
export function stableForkId(fullName: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < fullName.length; i++) {
    hash ^= fullName.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash * 1000 + (fullName.length % 1000)
}

// ════════════════════════════════════════════════════════════════════════════
// DB access — idempotent where the table allows; service-role only.
// ════════════════════════════════════════════════════════════════════════════

async function selectTrackedProjects(
  deps: BackfillDeps
): Promise<BackfillProject[]> {
  const { data, error } = await deps.admin
    .from('projects')
    .select('id, owner, repo')
    .eq('is_tracked', true)
    .is('deleted_at', null)
  if (error) throw error
  return (data ?? []) as BackfillProject[]
}

async function appendStars(deps: BackfillDeps, rows: StarInsert[]): Promise<void> {
  const { error } = await deps.admin
    .from('stars')
    .upsert(rows, { onConflict: 'repo,github_user', ignoreDuplicates: true })
  if (error) throw error
}

async function appendForks(deps: BackfillDeps, rows: ForkInsert[]): Promise<void> {
  const { error } = await deps.admin
    .from('forks')
    .upsert(rows, { onConflict: 'repo,fork_id', ignoreDuplicates: true })
  if (error) throw error
}

/**
 * Replace this project's ship-cadence series: delete the existing
 * `ship_cadence` snapshot rows, then insert the recomputed buckets. This is the
 * idempotency mechanism for a metric whose table has no unique key — a re-run
 * recomputes the same buckets from the same history and ends in identical state.
 */
async function replaceShipCadence(
  deps: BackfillDeps,
  projectId: string,
  rows: SnapshotInsert[]
): Promise<void> {
  const del = await deps.admin
    .from('signal_snapshots')
    .delete()
    .eq('project_id', projectId)
    .eq('metric', METRIC_SHIP_CADENCE)
  if (del.error) throw del.error

  if (rows.length === 0) return
  const ins = await deps.admin.from('signal_snapshots').insert(rows)
  if (ins.error) throw ins.error
}

// ════════════════════════════════════════════════════════════════════════════
// Runner — wires production dependencies. Gated behind GS-001 (U0 ops).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the production `BackfillDeps`: a real service-role admin client, a real
 * GitHubClient factory, real timers. Reads secrets from the environment (see the
 * POST-GS-001 RUN STEPS in the file header) and refuses to run a LIVE backfill
 * unless `CAPTURE_ENABLED=true` is set explicitly — the same default-off opt-in
 * the rest of the capture path uses, so a stray invocation can't hammer GitHub /
 * write to the DB by accident. `--dry-run` bypasses the write path (and so does
 * not require the gate to be on).
 *
 * Imported lazily inside main() so the pure logic above stays importable in unit
 * tests without pulling in `server-only` (the admin client) or env requirements.
 */
async function buildProductionDeps(dryRun: boolean): Promise<BackfillDeps> {
  const captureEnabled = process.env.CAPTURE_ENABLED === 'true'
  if (!dryRun && !captureEnabled) {
    throw new Error(
      'Refusing to run a LIVE backfill with CAPTURE_ENABLED!=true. Set ' +
        'CAPTURE_ENABLED=true to write, or pass --dry-run to walk without writing.'
    )
  }

  const token = process.env.GITHUB_TOKEN
  if (!token || token.length === 0) {
    throw new Error('Missing GITHUB_TOKEN (the fine-grained, repo-scoped PAT).')
  }

  // Lazy imports: keep `server-only` (admin) + the client out of the module's
  // top-level so the pure exports are unit-testable without them.
  const { getAdmin } = await import('@/lib/supabase/admin')
  const { GitHubClient } = await import('@/lib/github/client')

  return {
    admin: getAdmin() as unknown as Admin,
    makeClient: (signal?: AbortSignal) => new GitHubClient({ token, signal }),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    dryRun,
    log: (msg, meta) =>
      console.log(`[backfill] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
  }
}

/** CLI entry: `pnpm exec tsx scripts/backfill.ts [--dry-run]`. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const dryRun = argv.includes('--dry-run')
  console.log(
    `[backfill] starting${dryRun ? ' (DRY RUN — no writes)' : ''}…`
  )

  const deps = await buildProductionDeps(dryRun)
  const summary = await runBackfill(deps)

  console.log(
    `[backfill] done: ${summary.reposOk}/${summary.reposTotal} repos ok, ` +
      `${summary.reposFailed} failed.`
  )
  for (const r of summary.results) {
    console.log(
      `[backfill]   ${r.repo}: ${r.starsUpserted} stars, ${r.forksUpserted} forks, ` +
        `${r.shipCadenceBuckets} cadence buckets (${r.shipEvents} ship events).`
    )
  }
  for (const f of summary.failures) {
    console.error(`[backfill]   FAILED ${f.repo}: ${String(f.error)}`)
  }

  // Non-zero exit if any repo failed, so a CI/cron invocation surfaces it.
  if (summary.reposFailed > 0) process.exitCode = 1
}

// Run when executed directly (tsx), not when imported by tests. `import.meta.url`
// vs the invoked argv[1] is the ESM equivalent of `require.main === module`.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[backfill] fatal:', err)
    process.exitCode = 1
  })
}
