/**
 * Derived metrics layer — U8 (R10, R11, R12 · KTD1, KTD6, KTD12).
 *
 * Turns raw snapshots/event-logs into the velocity / growth / aggregate numbers
 * the showcase + radar render — correct for SPARSE, MIXED-PROVENANCE, LOW-COUNT
 * data. This is the pure TypeScript half of U8; `supabase/migrations/
 * 00002_derived_views.sql` expresses the same contract in SQL for the read path
 * that joins onto `public_showcase` / `gs_published_projects()` (published-only).
 *
 * The hard rules this module enforces (all from KTD1/KTD6/KTD12):
 *
 *   1. Per-day download deltas = diff of consecutive CUMULATIVE download
 *      snapshots. When a snapshot carries a `span_days > 1` marker (a
 *      missed-capture gap recorded by U4), the merged delta is NOT a single-day
 *      spike — it is DISTRIBUTED evenly across the spanned days for smoothing,
 *      and the affected points are flagged.
 *
 *   2. Velocity is SMOOTHED over a trailing window (default 7-day), never raw
 *      day-over-day. A 0/1/3 spike train resolves to a stable per-day rate.
 *
 *   3. Growth % is SUPPRESSED below an absolute-count floor. Below the floor we
 *      surface an absolute delta ("+12 this month"), never "+100%" off a tiny
 *      base. A zero baseline ALWAYS suppresses (no division by zero, no infinity).
 *
 *   4. Aggregate cross-project roll-ups ALIGN every series to a common capture
 *      epoch, so a backfilled star curve that starts years before download
 *      capture doesn't distort the aggregate's SHAPE.
 *
 *   5. Window-level uniques come from `traffic_window` DIRECTLY — this module
 *      exposes no path that sums daily uniques (uniques are non-additive, KTD1).
 *
 *   6. Degradation is per-(project, metric). A series with < 2 usable points
 *      shows its absolute value + a `tracking_started` marker — never a false
 *      0% and never an error. A fresh repo can therefore present a backfilled
 *      star curve AND a "tracking started" download velocity at the same time.
 *
 * Everything here is a PURE function over plain inputs — no DB, no clock, no I/O —
 * so the whole contract is unit-testable (derive.test.ts) without a live DB.
 */

// ============================================================================
// Inputs — plain shapes the caller maps from the raw tables
// ============================================================================

/**
 * A cumulative-counter snapshot (e.g. downloads, stars-count, watchers): one
 * monotonic running total stamped at `capturedAt`. `spanDays` is the U4 gap
 * marker: when the previous capture was missed, `spanDays` is the whole-day span
 * the delta INTO this point covers (≥ 2 means a merged multi-day delta). Default
 * 1 = a normal consecutive day.
 *
 * Maps from `signal_snapshots` where `data_class = 'cumulative'`: the `value` is
 * `cumulative`; a sibling `<metric>_span_days` row at the same `captured_at`
 * supplies `spanDays`.
 */
export interface CumulativePoint {
  /** ISO-8601 timestamp the snapshot was captured at. */
  capturedAt: string
  /** The cumulative running total at `capturedAt` (clamped >= 0 on ingest). */
  cumulative: number
  /**
   * Whole-day span the delta into this point covers (U4 marker). 1 = normal
   * consecutive capture; >= 2 = a merged multi-day delta from a missed run.
   */
  spanDays?: number
}

/**
 * A backfillable point-event with its own native timestamp (a star or a fork).
 * These produce a true historical curve via running cumulative count — no
 * diffing, no capture-date floor (R8 / KTD6). `at` is the EVENT time
 * (`stars.starred_at` / `forks.created_at`), not the ingest time.
 */
export interface EventPoint {
  /** ISO-8601 event timestamp (when the star/fork actually happened). */
  at: string
}

/**
 * Authoritative window-level uniques, read DIRECTLY from `traffic_window`
 * (KTD1). The caller passes the row's own `uniques`; this module never derives
 * it from daily rows. `count` is the window-level total events.
 */
export interface WindowUniques {
  windowStart: string
  windowEnd: string
  /** Authoritative window-level unique count (never summed from dailies). */
  uniques: number
  /** Window-level total events. */
  count: number
}

// ============================================================================
// Outputs
// ============================================================================

/** Why a series degraded (or didn't). */
export type SeriesStatus =
  /** >= 2 usable points: velocity/growth are real. */
  | 'ok'
  /** < 2 usable points: absolute + "tracking started", no false 0%. */
  | 'tracking_started'

/**
 * A normalized per-day delta point derived from cumulative snapshots. `value` is
 * the PER-DAY contribution (a merged multi-day delta is distributed evenly), so
 * a sum over `value`s equals the true total movement. `merged` flags a point
 * that came from a `span_days > 1` gap, so the UI can render it honestly (e.g.
 * a dashed segment) rather than as a real single-day spike.
 */
export interface DeltaPoint {
  /** `YYYY-MM-DD` UTC day this per-day contribution is attributed to. */
  day: string
  /** Per-day value (multi-day deltas are distributed across their span). */
  value: number
  /** True when this day is part of a distributed multi-day (gap-merged) delta. */
  merged: boolean
}

/**
 * The derived numbers for one (project, metric) cumulative series.
 *
 * `growthPct` is null whenever growth framing is suppressed (below the floor or
 * a zero baseline). In that case the UI shows `absoluteDelta` instead — never a
 * misleading percentage (KTD12). When `status` is `tracking_started`,
 * velocity/growth/delta are all null and only `latest` + `trackingStartedAt`
 * are meaningful (R12 / AE1).
 */
export interface MetricSummary {
  status: SeriesStatus
  /** Latest cumulative value (always present when >= 1 point exists). */
  latest: number
  /** ISO day of the first snapshot — the "tracking started" anchor. */
  trackingStartedAt: string | null
  /** Smoothed per-day velocity over the trailing window; null when degraded. */
  velocityPerDay: number | null
  /** Window length (days) the velocity was smoothed over. */
  velocityWindowDays: number
  /** Absolute movement over the growth window; null when degraded. */
  absoluteDelta: number | null
  /**
   * Growth as a fraction (0.18 = +18%), or null when SUPPRESSED (below the
   * absolute-count floor, or a zero baseline). Null is the signal to render
   * `absoluteDelta` instead of a percentage (KTD12).
   */
  growthPct: number | null
}

/** A point on a cumulative curve (for sparklines / area charts). */
export interface CurvePoint {
  day: string
  cumulative: number
}

// ============================================================================
// Tunables
// ============================================================================

/**
 * Default config. All thresholds are explicit and overridable so the showcase
 * (recruiter-facing, conservative) and the radar (owner-facing) can differ.
 */
export interface DeriveConfig {
  /** Trailing window (days) the velocity is smoothed over (KTD6). */
  velocityWindowDays: number
  /** Window (days) growth % / absolute delta are measured over. */
  growthWindowDays: number
  /**
   * Absolute-count floor (KTD12). Growth % is SUPPRESSED when the window's
   * baseline value is below this — show the absolute delta instead. Guards
   * against "+100%" off a base of 1. The baseline (not the latest) is the gate:
   * a denominator that small makes any percentage noise.
   */
  growthAbsoluteFloor: number
}

export const DEFAULT_CONFIG: DeriveConfig = {
  velocityWindowDays: 7,
  growthWindowDays: 30,
  // A baseline under 50 makes percentage framing noisy/evasive for a recruiter
  // (KTD12): "+100%" off 3 downloads is meaningless; "+3 this month" is honest.
  growthAbsoluteFloor: 50,
}

// ============================================================================
// Date helpers (UTC-only — capture stamps are UTC; days are YYYY-MM-DD)
// ============================================================================

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/** The `YYYY-MM-DD` UTC day of an ISO timestamp, or null if unparseable. */
export function isoDay(timestamp: string): string | null {
  const ms = Date.parse(timestamp)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

/** Parse a `YYYY-MM-DD` (or ISO) to epoch ms at UTC midnight, or NaN. */
function dayToMs(day: string): number {
  // Normalize to the date portion so a full ISO stamp and a bare day agree.
  const d = day.length > 10 ? day.slice(0, 10) : day
  return Date.parse(`${d}T00:00:00.000Z`)
}

/** Whole-day difference `b - a` (both `YYYY-MM-DD`/ISO), or NaN. */
function dayDiff(a: string, b: string): number {
  const ams = dayToMs(a)
  const bms = dayToMs(b)
  if (Number.isNaN(ams) || Number.isNaN(bms)) return Number.NaN
  return Math.round((bms - ams) / ONE_DAY_MS)
}

/** `day` shifted by `n` whole days, as `YYYY-MM-DD` UTC. */
function addDays(day: string, n: number): string {
  return new Date(dayToMs(day) + n * ONE_DAY_MS).toISOString().slice(0, 10)
}

// ============================================================================
// 1. Per-day download deltas (diff cumulative; distribute span-marked gaps)
// ============================================================================

/**
 * Diff consecutive cumulative snapshots into PER-DAY deltas.
 *
 * - Snapshots are sorted by `capturedAt` and collapsed to one point per UTC day
 *   (the last cumulative seen that day wins — a same-day re-capture overwrites,
 *   matching the DB upsert semantics).
 * - The first day has no predecessor, so it seeds the baseline and emits no
 *   delta (you cannot know a single snapshot's daily rate — R12).
 * - Each later day's delta = `cumulative - previousCumulative`, clamped to >= 0
 *   (a cumulative counter should never go down; if it does — a deleted release —
 *   we floor at 0 rather than emit a negative rate).
 * - When a point carries `spanDays > 1` (a U4 gap marker), its delta covers
 *   `spanDays` days. We DISTRIBUTE it evenly across those days (so smoothing
 *   doesn't see a fake spike, KTD1) and flag every distributed day `merged`.
 *   The remainder from integer division is placed on the final (capture) day so
 *   the distributed values still sum to the exact delta.
 *
 * The returned array is dense across the spanned gap days but otherwise only has
 * days that were actually captured.
 */
export function deltasFromCumulative(points: CumulativePoint[]): DeltaPoint[] {
  const collapsed = collapseToDaily(points)
  if (collapsed.length < 2) return []

  const out: DeltaPoint[] = []
  for (let i = 1; i < collapsed.length; i++) {
    const prev = collapsed[i - 1]
    const curr = collapsed[i]
    const rawDelta = Math.max(0, curr.cumulative - prev.cumulative)

    // How many days does this delta actually cover? Prefer the explicit U4
    // marker; fall back to the real calendar gap between captures (a missed
    // marker shouldn't let a 5-day gap masquerade as one day). Never < 1.
    const calendarGap = dayDiff(prev.day, curr.day)
    const markerSpan = curr.spanDays && curr.spanDays > 1 ? curr.spanDays : 1
    const span = Math.max(1, markerSpan, Number.isNaN(calendarGap) ? 1 : calendarGap)

    if (span <= 1) {
      out.push({ day: curr.day, value: rawDelta, merged: false })
      continue
    }

    // Distribute the merged delta evenly across the spanned days. The spanned
    // days are the `span` days ENDING on the capture day (inclusive), i.e.
    // (curr.day - span + 1) … curr.day. Integer base per day + remainder on the
    // last day keeps the sum exact.
    const base = Math.floor(rawDelta / span)
    const remainder = rawDelta - base * span
    for (let d = span - 1; d >= 0; d--) {
      const day = addDays(curr.day, -d)
      const value = d === 0 ? base + remainder : base
      out.push({ day, value, merged: true })
    }
  }
  return out
}

/** Collapse raw cumulative points to one-per-UTC-day, sorted ascending. */
function collapseToDaily(
  points: CumulativePoint[]
): Array<{ day: string; cumulative: number; spanDays?: number }> {
  const byDay = new Map<string, { cumulative: number; spanDays?: number; ms: number }>()
  for (const p of points) {
    const day = isoDay(p.capturedAt)
    if (day === null) continue
    const ms = Date.parse(p.capturedAt)
    const existing = byDay.get(day)
    // Last capture of the day wins (same-day re-capture overwrites, like the DB).
    if (existing === undefined || ms >= existing.ms) {
      byDay.set(day, {
        cumulative: Math.max(0, p.cumulative),
        spanDays: p.spanDays,
        ms,
      })
    }
  }
  return [...byDay.entries()]
    .map(([day, v]) => ({ day, cumulative: v.cumulative, spanDays: v.spanDays }))
    .sort((a, b) => a.day.localeCompare(b.day))
}

// ============================================================================
// 2. Smoothed velocity (trailing window — never raw day-over-day)
// ============================================================================

/**
 * Smoothed per-day velocity over the trailing `windowDays` ENDING on the last
 * delta day. We sum the per-day deltas inside the trailing window and divide by
 * the window length in days — so a 0/1/3 spike train resolves to a calm
 * fractional rate instead of jumping 0 → 3 → 0 (KTD6).
 *
 * Dividing by the fixed window length (not the count of captured days) is what
 * makes it a true *rate*: a quiet day genuinely contributes 0, which is the
 * correct smoothing behavior. Returns null when there are no deltas (degraded —
 * the caller surfaces "tracking started").
 */
export function smoothedVelocity(
  deltas: DeltaPoint[],
  windowDays: number
): number | null {
  if (deltas.length === 0) return null
  const win = Math.max(1, Math.floor(windowDays))

  const lastDay = deltas[deltas.length - 1].day
  // Trailing window is [lastDay - win + 1, lastDay] inclusive.
  const cutoff = addDays(lastDay, -(win - 1))

  let sum = 0
  for (const d of deltas) {
    if (d.day >= cutoff && d.day <= lastDay) sum += d.value
  }
  return sum / win
}

// ============================================================================
// 3. Growth % with absolute-count floor suppression (KTD12)
// ============================================================================

/**
 * Growth over the trailing `windowDays`, computed from the cumulative curve.
 *
 * Returns BOTH the absolute delta and the percentage — but the percentage is
 * `null` (SUPPRESSED) whenever:
 *   - the baseline (the cumulative value at the start of the window) is below
 *     `absoluteFloor` — "+100%" off a base of 3 is noise (KTD12), or
 *   - the baseline is 0 — there is no honest denominator (no Infinity / NaN).
 *
 * The baseline is the cumulative value at-or-before the window start (the most
 * recent point not after the cutoff). When the series starts INSIDE the window
 * (a young series), the earliest point is the baseline. With < 2 points there is
 * no movement to measure → both null.
 */
export function growthOverWindow(
  curve: CurvePoint[],
  windowDays: number,
  absoluteFloor: number
): { absoluteDelta: number | null; growthPct: number | null } {
  if (curve.length < 2) return { absoluteDelta: null, growthPct: null }

  const sorted = [...curve].sort((a, b) => a.day.localeCompare(b.day))
  const latest = sorted[sorted.length - 1]
  const win = Math.max(1, Math.floor(windowDays))
  const cutoff = addDays(latest.day, -win)

  // Baseline = most recent cumulative at-or-before the cutoff; if the whole
  // series is younger than the window, fall back to the earliest point.
  let baseline = sorted[0]
  for (const p of sorted) {
    if (p.day <= cutoff) baseline = p
    else break
  }

  const absoluteDelta = latest.cumulative - baseline.cumulative

  // Suppress percentage below the floor or on a zero baseline (KTD12).
  if (baseline.cumulative < absoluteFloor || baseline.cumulative === 0) {
    return { absoluteDelta, growthPct: null }
  }
  return {
    absoluteDelta,
    growthPct: absoluteDelta / baseline.cumulative,
  }
}

// ============================================================================
// 4. Cumulative curves (for charts) — downloads, stars, forks
// ============================================================================

/**
 * Rebuild the per-day cumulative curve from cumulative snapshots (collapsed to
 * one-per-day). Used for the download area chart + as the growth input. The
 * curve carries only captured days (it is not forward-filled here; the chart
 * layer decides how to render gaps, with the `merged` deltas marking them).
 */
export function cumulativeCurve(points: CumulativePoint[]): CurvePoint[] {
  return collapseToDaily(points).map((p) => ({
    day: p.day,
    cumulative: p.cumulative,
  }))
}

/**
 * Build a cumulative curve from a backfillable EVENT log (stars or forks). Each
 * event increments a running count at its own native day; the result is a true
 * historical curve (R8) that needs NO capture-date floor — a fresh repo shows
 * its full backfilled star curve immediately (AE4 / AE6). One point per day with
 * at least one event, carrying the running total.
 */
export function eventCumulativeCurve(events: EventPoint[]): CurvePoint[] {
  const perDay = new Map<string, number>()
  for (const e of events) {
    const day = isoDay(e.at)
    if (day === null) continue
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }
  const days = [...perDay.keys()].sort((a, b) => a.localeCompare(b))
  let running = 0
  return days.map((day) => {
    running += perDay.get(day) as number
    return { day, cumulative: running }
  })
}

// ============================================================================
// 5. Window uniques — read DIRECTLY from traffic_window (never summed)
// ============================================================================

/**
 * The authoritative window-level uniques for a metric (KTD1 / AE5). Picks the
 * MOST RECENT captured window and returns its own `uniques` — this module
 * deliberately exposes NO function that sums daily uniques. Returns null when no
 * window rows exist (degraded). `count` (window total events) is additive and
 * returned alongside for convenience.
 *
 * The input is the set of `traffic_window` rows for one (repo, metric); the
 * "monthly uniques" the showcase shows is THIS number, not a sum of dailies.
 */
export function windowUniques(
  windows: WindowUniques[]
): { uniques: number; count: number; windowStart: string; windowEnd: string } | null {
  if (windows.length === 0) return null
  // Most recent window by end date (then start, as a tiebreak).
  const latest = [...windows].sort((a, b) => {
    const byEnd = b.windowEnd.localeCompare(a.windowEnd)
    return byEnd !== 0 ? byEnd : b.windowStart.localeCompare(a.windowStart)
  })[0]
  return {
    uniques: Math.max(0, latest.uniques),
    count: Math.max(0, latest.count),
    windowStart: latest.windowStart,
    windowEnd: latest.windowEnd,
  }
}

// ============================================================================
// 6. Per-(project, metric) summary with graceful degradation (R12 / AE1)
// ============================================================================

/**
 * Derive the full summary for ONE cumulative (project, metric) series, applying
 * per-(project,metric) degradation (KTD6). This is the function the showcase /
 * radar call per download-style metric.
 *
 * Degradation (R12 / AE1): with < 2 usable daily points the series cannot have a
 * velocity or a growth rate, so we return `status: 'tracking_started'` with the
 * absolute `latest` and the `trackingStartedAt` anchor — and ALL of
 * velocity/growth/delta null. Never a false 0%, never an error. A repo whose
 * downloads are one day old gets this for downloads while its stars curve (a
 * different metric, derived separately via `eventCumulativeCurve`) is fully
 * populated — the two coexist (AE4).
 */
export function deriveCumulativeMetric(
  points: CumulativePoint[],
  config: DeriveConfig = DEFAULT_CONFIG
): MetricSummary {
  const curve = cumulativeCurve(points)

  // No data at all.
  if (curve.length === 0) {
    return {
      status: 'tracking_started',
      latest: 0,
      trackingStartedAt: null,
      velocityPerDay: null,
      velocityWindowDays: config.velocityWindowDays,
      absoluteDelta: null,
      growthPct: null,
    }
  }

  const latest = curve[curve.length - 1].cumulative
  const trackingStartedAt = curve[0].day

  // < 2 points: degrade to absolute + "tracking started" (R12 / AE1). No false
  // 0%, no division, no error.
  if (curve.length < 2) {
    return {
      status: 'tracking_started',
      latest,
      trackingStartedAt,
      velocityPerDay: null,
      velocityWindowDays: config.velocityWindowDays,
      absoluteDelta: null,
      growthPct: null,
    }
  }

  const deltas = deltasFromCumulative(points)
  const velocityPerDay = smoothedVelocity(deltas, config.velocityWindowDays)
  const { absoluteDelta, growthPct } = growthOverWindow(
    curve,
    config.growthWindowDays,
    config.growthAbsoluteFloor
  )

  return {
    status: 'ok',
    latest,
    trackingStartedAt,
    velocityPerDay,
    velocityWindowDays: config.velocityWindowDays,
    absoluteDelta,
    growthPct,
  }
}

// ============================================================================
// 7. Aggregate cross-project roll-up, epoch-aligned (R11 / KTD12)
// ============================================================================

/** One project's contribution to an aggregate: its cumulative curve for a metric. */
export interface ProjectSeries {
  projectId: string
  /** The project's cumulative curve for the metric being aggregated. */
  curve: CurvePoint[]
}

/** A day on the aggregate (epoch-aligned) curve. */
export interface AggregatePoint {
  day: string
  /** Sum across all projects of their cumulative value as-of `day`. */
  total: number
}

/**
 * Roll up many projects' cumulative curves into one aggregate curve, ALIGNED to
 * a common capture epoch (KTD12). The "epoch" is the latest of every series'
 * FIRST day — i.e. the first day on which we hold a real captured value for
 * EVERY contributing series. Aligning here is what stops a backfilled star
 * curve that begins years before download capture from distorting the
 * aggregate's SHAPE: before the epoch some series have no captured value and
 * would otherwise read as 0, inventing a fake ramp.
 *
 * For each day from the epoch to the latest day across all series, each series
 * contributes its most-recent cumulative value at-or-before that day
 * (forward-filled within its own captured range). Series are summed per day.
 *
 * `epoch` is returned so the caller can label the aggregate honestly
 * ("aggregate since <epoch>"). With no series, returns an empty curve and a null
 * epoch (degraded — caller shows the absolute hero from `aggregateLatestTotal`).
 *
 * NOTE: the absolute hero number (KTD12 — "total downloads across projects")
 * does NOT need epoch alignment; it is just the sum of each series' LATEST
 * cumulative (see `aggregateLatestTotal`). Epoch alignment is only about the
 * curve's SHAPE over time.
 */
export function aggregateEpochAligned(series: ProjectSeries[]): {
  epoch: string | null
  curve: AggregatePoint[]
} {
  const nonEmpty = series.filter((s) => s.curve.length > 0)
  if (nonEmpty.length === 0) return { epoch: null, curve: [] }

  // Sort each series' curve once and find each one's first/last day.
  const sorted = nonEmpty.map((s) => ({
    points: [...s.curve].sort((a, b) => a.day.localeCompare(b.day)),
  }))

  // Epoch = the latest first-day across series (the common-coverage start). Max
  // of per-series mins. Latest day = max of per-series maxes.
  let epoch = sorted[0].points[0].day
  let lastDay = sorted[0].points[sorted[0].points.length - 1].day
  for (const s of sorted) {
    const first = s.points[0].day
    const last = s.points[s.points.length - 1].day
    if (first > epoch) epoch = first
    if (last > lastDay) lastDay = last
  }

  const span = dayDiff(epoch, lastDay)
  // Defensive: if dates are malformed, fall back to the latest-total point only.
  if (Number.isNaN(span) || span < 0) {
    return {
      epoch,
      curve: [{ day: epoch, total: aggregateLatestTotal(series) }],
    }
  }

  const curve: AggregatePoint[] = []
  for (let d = 0; d <= span; d++) {
    const day = addDays(epoch, d)
    let total = 0
    for (const s of sorted) {
      total += cumulativeAsOf(s.points, day)
    }
    curve.push({ day, total })
  }
  return { epoch, curve }
}

/**
 * The honest absolute hero anchor (KTD12): the sum across projects of each
 * series' LATEST cumulative value. Available immediately from cumulative counts,
 * needs no epoch alignment, and is the "total downloads + total stars" the
 * showcase leads with. Empty series contribute 0.
 */
export function aggregateLatestTotal(series: ProjectSeries[]): number {
  let total = 0
  for (const s of series) {
    if (s.curve.length === 0) continue
    const sorted = [...s.curve].sort((a, b) => a.day.localeCompare(b.day))
    total += sorted[sorted.length - 1].cumulative
  }
  return total
}

/** A series' most-recent cumulative value at-or-before `day` (forward-fill). */
function cumulativeAsOf(
  sortedPoints: CurvePoint[],
  day: string
): number {
  let value = 0
  let seen = false
  for (const p of sortedPoints) {
    if (p.day <= day) {
      value = p.cumulative
      seen = true
    } else {
      break
    }
  }
  // Before a series' first captured day it has NO value — contribute 0 (the
  // epoch guarantees we don't sum across pre-coverage gaps for the shaped curve).
  return seen ? value : 0
}
