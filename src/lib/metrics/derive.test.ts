import { describe, it, expect } from 'vitest'
import {
  deltasFromCumulative,
  smoothedVelocity,
  growthOverWindow,
  cumulativeCurve,
  eventCumulativeCurve,
  windowUniques,
  deriveCumulativeMetric,
  aggregateEpochAligned,
  aggregateLatestTotal,
  isoDay,
  DEFAULT_CONFIG,
  type CumulativePoint,
  type EventPoint,
  type WindowUniques,
  type CurvePoint,
  type ProjectSeries,
} from './derive'

/**
 * U8 derived-metrics contract tests (R10, R11, R12 · KTD1, KTD6, KTD12).
 *
 * Test-first and correctness-critical: these pin the rules the showcase + radar
 * (and the parallel SQL views in 00002_derived_views.sql) depend on for SPARSE,
 * MIXED-PROVENANCE, LOW-COUNT data. Pure functions, no DB, no clock.
 *
 * Acceptance examples covered (plan §Acceptance Examples / U8 test scenarios):
 *   • AE1 — single snapshot → absolute + "tracking started", no false 0%.
 *   • AE5 — monthly uniques use the window total, NEVER the sum of dailies.
 *   • %-floor — growth % suppressed below the absolute-count floor.
 *   • AE4 — backfilled stars curve while downloads start at capture date (per metric).
 *   • epoch-aligned aggregate with mixed start dates.
 *   • smoothed velocity stable on a 0/1/3 spike train.
 *   • span_days gap marker → distributed, not read as a single-day spike (KTD1).
 */

// ─── small builders ─────────────────────────────────────────────────────────

/** Cumulative point at UTC noon of `day` (noon avoids any TZ-edge ambiguity). */
const cum = (day: string, cumulative: number, spanDays?: number): CumulativePoint => ({
  capturedAt: `${day}T12:00:00.000Z`,
  cumulative,
  ...(spanDays !== undefined ? { spanDays } : {}),
})

const curvePt = (day: string, cumulative: number): CurvePoint => ({ day, cumulative })

// ════════════════════════════════════════════════════════════════════════════
// isoDay — UTC day extraction
// ════════════════════════════════════════════════════════════════════════════

describe('isoDay', () => {
  it('extracts the UTC YYYY-MM-DD from an ISO stamp', () => {
    expect(isoDay('2026-06-10T23:30:00.000Z')).toBe('2026-06-10')
  })
  it('returns null for an unparseable stamp', () => {
    expect(isoDay('not-a-date')).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 1. Per-day download deltas (diff cumulative) + span-marker distribution
// ════════════════════════════════════════════════════════════════════════════

describe('deltasFromCumulative — consecutive daily diffs', () => {
  it('diffs consecutive cumulative snapshots into per-day deltas', () => {
    const deltas = deltasFromCumulative([
      cum('2026-06-01', 100),
      cum('2026-06-02', 105),
      cum('2026-06-03', 111),
    ])
    // First day seeds the baseline (no delta); then 5, then 6.
    expect(deltas).toEqual([
      { day: '2026-06-02', value: 5, merged: false },
      { day: '2026-06-03', value: 6, merged: false },
    ])
  })

  it('emits no delta for a single snapshot (cannot know a daily rate)', () => {
    expect(deltasFromCumulative([cum('2026-06-01', 100)])).toEqual([])
  })

  it('collapses same-day re-captures to the last value (DB upsert semantics)', () => {
    const deltas = deltasFromCumulative([
      cum('2026-06-01', 100),
      // two captures on 06-02: the later (108) wins
      { capturedAt: '2026-06-02T06:00:00.000Z', cumulative: 104 },
      { capturedAt: '2026-06-02T18:00:00.000Z', cumulative: 108 },
    ])
    expect(deltas).toEqual([{ day: '2026-06-02', value: 8, merged: false }])
  })

  it('clamps a decreasing cumulative (e.g. a deleted release) to 0, never negative', () => {
    const deltas = deltasFromCumulative([
      cum('2026-06-01', 100),
      cum('2026-06-02', 90), // counter went DOWN
    ])
    expect(deltas).toEqual([{ day: '2026-06-02', value: 0, merged: false }])
  })
})

describe('deltasFromCumulative — span_days gap marker (KTD1)', () => {
  it('distributes a merged multi-day delta evenly across the spanned days, flagged merged', () => {
    // Captured 06-01 (=100), then missed 4 days, captured 06-05 (=120) with a
    // span marker of 4. The +20 must NOT be a single-day spike on 06-05; it is
    // distributed across 06-02..06-05 (4 days) → 5/day, all flagged merged.
    const deltas = deltasFromCumulative([
      cum('2026-06-01', 100),
      cum('2026-06-05', 120, 4),
    ])
    expect(deltas).toEqual([
      { day: '2026-06-02', value: 5, merged: true },
      { day: '2026-06-03', value: 5, merged: true },
      { day: '2026-06-04', value: 5, merged: true },
      { day: '2026-06-05', value: 5, merged: true },
    ])
    // The distributed values sum to EXACTLY the real delta.
    expect(deltas.reduce((s, d) => s + d.value, 0)).toBe(20)
  })

  it('puts the integer remainder on the final (capture) day so the sum stays exact', () => {
    // +22 over a 4-day span → base 5/day, remainder 2 lands on the capture day.
    const deltas = deltasFromCumulative([cum('2026-06-01', 0), cum('2026-06-05', 22, 4)])
    expect(deltas.map((d) => d.value)).toEqual([5, 5, 5, 7])
    expect(deltas.every((d) => d.merged)).toBe(true)
    expect(deltas.reduce((s, d) => s + d.value, 0)).toBe(22)
  })

  it('falls back to the real calendar gap when the span marker is missing', () => {
    // No marker, but the captures are 4 days apart — the gap must still be
    // distributed (a missed marker must not let a 4-day jump read as one day).
    const deltas = deltasFromCumulative([cum('2026-06-01', 100), cum('2026-06-05', 120)])
    expect(deltas.map((d) => d.day)).toEqual([
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ])
    expect(deltas.every((d) => d.merged)).toBe(true)
    expect(deltas.reduce((s, d) => s + d.value, 0)).toBe(20)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. Smoothed velocity — stable on a 0/1/3 spike train (KTD6)
// ════════════════════════════════════════════════════════════════════════════

describe('smoothedVelocity — trailing window, never raw day-over-day', () => {
  it('resolves a 0/1/3 spike train to a stable per-day rate', () => {
    // A bursty download pattern: most days 0, occasional 1 or 3. Day-over-day
    // this lurches 0→3→0; smoothed over 7 days it is a calm fraction.
    // cumulative: build deltas 0,1,0,3,0,1,0 across 7 days after a baseline day.
    const points = [
      cum('2026-06-01', 0), // baseline (no delta)
      cum('2026-06-02', 0), // +0
      cum('2026-06-03', 1), // +1
      cum('2026-06-04', 1), // +0
      cum('2026-06-05', 4), // +3
      cum('2026-06-06', 4), // +0
      cum('2026-06-07', 5), // +1
      cum('2026-06-08', 5), // +0
    ]
    const deltas = deltasFromCumulative(points)
    const v = smoothedVelocity(deltas, 7)
    // Trailing 7 days ending 06-08 = days 06-02..06-08 → sum 0+1+0+3+0+1+0 = 5,
    // divided by the 7-day window = 5/7 ≈ 0.714 — stable, not the raw 0 or 3.
    expect(v).toBeCloseTo(5 / 7, 6)
    // And it is well below the loud spike (3) and above the quiet day (0).
    expect(v).toBeGreaterThan(0)
    expect(v as number).toBeLessThan(3)
  })

  it('divides by the fixed window length so quiet days genuinely count as 0 rate', () => {
    // Only one +7 on the last day; over a 7-day window that is 1/day, not 7/day.
    const deltas = deltasFromCumulative([cum('2026-06-07', 0), cum('2026-06-08', 7)])
    expect(smoothedVelocity(deltas, 7)).toBeCloseTo(1, 6)
  })

  it('returns null when there are no deltas (degraded series)', () => {
    expect(smoothedVelocity([], 7)).toBeNull()
  })

  it('a span-distributed gap does not create a velocity spike', () => {
    // The same +20 as a single-day spike vs distributed over 4 days yields a far
    // lower, honest velocity — the whole point of the span marker (KTD1).
    const distributed = deltasFromCumulative([cum('2026-06-01', 100), cum('2026-06-05', 120, 4)])
    const vDistributed = smoothedVelocity(distributed, 7) as number
    // Distributed: 20 over the 7-day window = 20/7 ≈ 2.86 (spread evenly).
    expect(vDistributed).toBeCloseTo(20 / 7, 6)
    // A naive single-day reading would have put all 20 on one day — still 20/7
    // in a 7-day *sum*, but the per-day SHAPE (merged flags) prevents the chart
    // and any narrower window from showing a 20/day spike. Assert no single
    // delta day carries the full 20.
    expect(distributed.every((d) => d.value < 20)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. Growth % with absolute-count floor suppression (KTD12)
// ════════════════════════════════════════════════════════════════════════════

describe('growthOverWindow — percentage suppressed below the absolute floor', () => {
  it('suppresses % below the floor and returns the absolute delta instead', () => {
    // Baseline 3 → 6 over the window. Floor is 50, so % is SUPPRESSED (a "+100%"
    // off 3 is noise); the absolute delta (+3) is what the UI shows (KTD12).
    const curve = [curvePt('2026-05-10', 3), curvePt('2026-06-09', 6)]
    const { absoluteDelta, growthPct } = growthOverWindow(curve, 30, 50)
    expect(absoluteDelta).toBe(3)
    expect(growthPct).toBeNull()
  })

  it('reports a real percentage when the baseline is at/above the floor', () => {
    // Baseline 100 → 118 over the window, floor 50 → +18% is honest.
    const curve = [curvePt('2026-05-10', 100), curvePt('2026-06-09', 118)]
    const { absoluteDelta, growthPct } = growthOverWindow(curve, 30, 50)
    expect(absoluteDelta).toBe(18)
    expect(growthPct).toBeCloseTo(0.18, 6)
  })

  it('suppresses % on a zero baseline (no division by zero, no Infinity)', () => {
    const curve = [curvePt('2026-06-01', 0), curvePt('2026-06-09', 12)]
    const { absoluteDelta, growthPct } = growthOverWindow(curve, 30, 1)
    expect(absoluteDelta).toBe(12)
    expect(growthPct).toBeNull()
  })

  it('uses the cumulative at-or-before the window cutoff as the baseline', () => {
    // Window 30d ending 06-30; cutoff = 05-31. Baseline is the 05-20 point (120),
    // not the older 04-01 point (100) and not the in-window 06-15 point.
    const curve = [
      curvePt('2026-04-01', 100),
      curvePt('2026-05-20', 120),
      curvePt('2026-06-15', 150),
      curvePt('2026-06-30', 168),
    ]
    const { absoluteDelta, growthPct } = growthOverWindow(curve, 30, 50)
    expect(absoluteDelta).toBe(168 - 120) // 48
    expect(growthPct).toBeCloseTo(48 / 120, 6)
  })

  it('returns both null for a single point (no movement to measure)', () => {
    expect(growthOverWindow([curvePt('2026-06-09', 200)], 30, 50)).toEqual({
      absoluteDelta: null,
      growthPct: null,
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. Cumulative curves — downloads (snapshots) vs stars/forks (event logs)
// ════════════════════════════════════════════════════════════════════════════

describe('cumulativeCurve — from cumulative snapshots', () => {
  it('collapses to one point per day, sorted, last-of-day wins', () => {
    const curve = cumulativeCurve([
      cum('2026-06-02', 105),
      cum('2026-06-01', 100),
      { capturedAt: '2026-06-02T20:00:00.000Z', cumulative: 109 },
    ])
    expect(curve).toEqual([
      { day: '2026-06-01', cumulative: 100 },
      { day: '2026-06-02', cumulative: 109 },
    ])
  })
})

describe('eventCumulativeCurve — backfillable stars/forks (R8)', () => {
  it('builds a true historical running-count curve from event timestamps', () => {
    const stars: EventPoint[] = [
      { at: '2024-01-15T00:00:00Z' },
      { at: '2024-03-02T00:00:00Z' },
      { at: '2024-03-02T10:00:00Z' }, // same day → counts toward 03-02
      { at: '2025-11-20T00:00:00Z' },
    ]
    expect(eventCumulativeCurve(stars)).toEqual([
      { day: '2024-01-15', cumulative: 1 },
      { day: '2024-03-02', cumulative: 3 },
      { day: '2025-11-20', cumulative: 4 },
    ])
  })

  it('ignores events with unparseable timestamps rather than crashing', () => {
    const curve = eventCumulativeCurve([{ at: 'nope' }, { at: '2024-01-01T00:00:00Z' }])
    expect(curve).toEqual([{ day: '2024-01-01', cumulative: 1 }])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. AE5 — window uniques use the window total, NEVER the sum of dailies
// ════════════════════════════════════════════════════════════════════════════

describe('windowUniques — authoritative window total (AE5 / KTD1)', () => {
  it('returns the captured window-level uniques, not a sum of daily uniques', () => {
    // The authoritative monthly figure is 120 (the window total). If anyone
    // summed daily uniques they would get a WRONG, inflated number — this API
    // never exposes that path; it returns the window total directly.
    const windows: WindowUniques[] = [
      {
        windowStart: '2026-05-19',
        windowEnd: '2026-06-01',
        uniques: 120, // authoritative
        count: 700,
      },
    ]
    const result = windowUniques(windows)
    expect(result).not.toBeNull()
    expect(result?.uniques).toBe(120)
    expect(result?.count).toBe(700)
    // Guard the intent: 120 is deliberately LESS than a naive daily-sum would be
    // (e.g. 14 days × ~10/day = ~140). The window total is the smaller, correct
    // figure precisely because uniques are non-additive.
    expect(result?.uniques).toBeLessThan(14 * 10)
  })

  it('picks the most recently captured window when several exist', () => {
    const windows: WindowUniques[] = [
      { windowStart: '2026-04-01', windowEnd: '2026-04-14', uniques: 80, count: 400 },
      { windowStart: '2026-05-19', windowEnd: '2026-06-01', uniques: 120, count: 700 },
    ]
    expect(windowUniques(windows)?.uniques).toBe(120)
  })

  it('returns null when there are no window rows (degraded)', () => {
    expect(windowUniques([])).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. AE1 — single snapshot → absolute + "tracking started", no false 0%
// ════════════════════════════════════════════════════════════════════════════

describe('deriveCumulativeMetric — graceful degradation (AE1 / R12)', () => {
  it('a single snapshot shows absolute + tracking_started, never a false 0%', () => {
    const summary = deriveCumulativeMetric([cum('2026-06-10', 200)])
    expect(summary.status).toBe('tracking_started')
    expect(summary.latest).toBe(200)
    expect(summary.trackingStartedAt).toBe('2026-06-10')
    // The crux of AE1: no fabricated zero growth, no error.
    expect(summary.growthPct).toBeNull()
    expect(summary.absoluteDelta).toBeNull()
    expect(summary.velocityPerDay).toBeNull()
  })

  it('an empty series degrades cleanly (no points at all)', () => {
    const summary = deriveCumulativeMetric([])
    expect(summary.status).toBe('tracking_started')
    expect(summary.latest).toBe(0)
    expect(summary.trackingStartedAt).toBeNull()
    expect(summary.growthPct).toBeNull()
  })

  it('a healthy multi-point series reports ok with real velocity + growth', () => {
    // 30 days of steady +5/day off a base of 100 → growth honest, velocity ~5.
    // June 1..30 are all valid calendar days.
    const points: CumulativePoint[] = []
    for (let i = 0; i < 30; i++) {
      points.push(cum(`2026-06-${String(i + 1).padStart(2, '0')}`, 100 + i * 5))
    }
    const summary = deriveCumulativeMetric(points)
    expect(summary.status).toBe('ok')
    expect(summary.latest).toBe(100 + 29 * 5)
    expect(summary.velocityPerDay).toBeCloseTo(5, 6)
    expect(summary.growthPct).not.toBeNull()
  })

  it('a low-count multi-point series reports ok but SUPPRESSES the percentage', () => {
    // 5 points, base 3 → 9. There IS movement (status ok, real velocity), but the
    // base is below the floor so % is suppressed and the absolute delta shown.
    const summary = deriveCumulativeMetric([
      cum('2026-06-01', 3),
      cum('2026-06-02', 4),
      cum('2026-06-03', 6),
      cum('2026-06-04', 7),
      cum('2026-06-05', 9),
    ])
    expect(summary.status).toBe('ok')
    expect(summary.growthPct).toBeNull() // suppressed (base 3 < floor 50)
    expect(summary.absoluteDelta).toBe(6) // +6, the honest absolute movement
    expect(summary.velocityPerDay).not.toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// AE4 — backfilled stars curve WHILE downloads start at capture date (per metric)
// ════════════════════════════════════════════════════════════════════════════

describe('AE4 — a fresh repo: backfilled star curve + tracking-started downloads', () => {
  it('derives a full star curve and a degraded download velocity simultaneously', () => {
    // The repo was added to tracking TODAY. Stars backfill from stargazer
    // timestamps going back years; downloads have exactly one snapshot (today).
    // Per-(project,metric) degradation (KTD6): stars are rich, downloads are
    // "tracking started" — and the two coexist.
    const stars: EventPoint[] = [
      { at: '2023-02-01T00:00:00Z' },
      { at: '2023-08-15T00:00:00Z' },
      { at: '2024-05-20T00:00:00Z' },
      { at: '2026-06-10T00:00:00Z' },
    ]
    const starCurve = eventCumulativeCurve(stars)
    // Full backfilled curve, oldest event first — NOT floored at the capture date.
    expect(starCurve[0]).toEqual({ day: '2023-02-01', cumulative: 1 })
    expect(starCurve[starCurve.length - 1].cumulative).toBe(4)

    // Downloads: a single capture today → degraded, no false 0%.
    const downloads = deriveCumulativeMetric([cum('2026-06-10', 200)])
    expect(downloads.status).toBe('tracking_started')
    expect(downloads.trackingStartedAt).toBe('2026-06-10')
    expect(downloads.growthPct).toBeNull()
    expect(downloads.velocityPerDay).toBeNull()

    // The point of AE4: the star curve starts in 2023 while downloads start in
    // 2026 — different provenance, derived independently, no cross-contamination.
    expect(starCurve[0].day < (downloads.trackingStartedAt as string)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7. Epoch-aligned aggregate with mixed start dates (R11 / KTD12)
// ════════════════════════════════════════════════════════════════════════════

describe('aggregateEpochAligned — mixed start dates align to a common epoch', () => {
  it('aligns to the latest first-day so a backfilled curve does not distort the shape', () => {
    // Project A (stars) backfilled from 2024; Project B (stars) tracked from
    // 2026-06-08. The epoch is the LATER first-day (2026-06-08) — before that, B
    // has no captured value, so summing would invent a fake ramp. Aligning to
    // the epoch means the aggregate curve only spans the common-coverage range.
    const a: ProjectSeries = {
      projectId: 'A',
      curve: [
        curvePt('2024-01-01', 10),
        curvePt('2026-06-08', 50),
        curvePt('2026-06-10', 52),
      ],
    }
    const b: ProjectSeries = {
      projectId: 'B',
      curve: [curvePt('2026-06-08', 5), curvePt('2026-06-10', 9)],
    }
    const { epoch, curve } = aggregateEpochAligned([a, b])
    expect(epoch).toBe('2026-06-08') // the LATER of the two first-days
    // Curve spans 06-08..06-10 (3 days), each summing forward-filled values.
    expect(curve.map((p) => p.day)).toEqual(['2026-06-08', '2026-06-09', '2026-06-10'])
    expect(curve[0].total).toBe(50 + 5) // 06-08
    expect(curve[1].total).toBe(50 + 5) // 06-09 forward-filled (no new captures)
    expect(curve[2].total).toBe(52 + 9) // 06-10
    // Crucially the curve does NOT start in 2024 with A alone (which would draw a
    // misleading flat-then-jump aggregate); it starts at the common epoch.
    expect(curve[0].day).toBe('2026-06-08')
  })

  it('aggregateLatestTotal sums each series LATEST cumulative (the honest hero, no alignment)', () => {
    // KTD12 hero number: total across projects, available immediately, no epoch.
    const a: ProjectSeries = {
      projectId: 'A',
      curve: [curvePt('2024-01-01', 10), curvePt('2026-06-10', 52)],
    }
    const b: ProjectSeries = {
      projectId: 'B',
      curve: [curvePt('2026-06-08', 5), curvePt('2026-06-10', 9)],
    }
    expect(aggregateLatestTotal([a, b])).toBe(52 + 9) // 61
  })

  it('returns an empty curve + null epoch when no series have points (degraded)', () => {
    expect(aggregateEpochAligned([])).toEqual({ epoch: null, curve: [] })
    expect(aggregateEpochAligned([{ projectId: 'X', curve: [] }])).toEqual({
      epoch: null,
      curve: [],
    })
    expect(aggregateLatestTotal([{ projectId: 'X', curve: [] }])).toBe(0)
  })

  it('a single series aligns to its own first day', () => {
    const a: ProjectSeries = {
      projectId: 'A',
      curve: [curvePt('2026-06-01', 100), curvePt('2026-06-03', 110)],
    }
    const { epoch, curve } = aggregateEpochAligned([a])
    expect(epoch).toBe('2026-06-01')
    expect(curve).toEqual([
      { day: '2026-06-01', total: 100 },
      { day: '2026-06-02', total: 100 }, // forward-filled
      { day: '2026-06-03', total: 110 },
    ])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Config surface
// ════════════════════════════════════════════════════════════════════════════

describe('DEFAULT_CONFIG', () => {
  it('ships sane defaults (7d velocity, 30d growth, floor 50)', () => {
    expect(DEFAULT_CONFIG.velocityWindowDays).toBe(7)
    expect(DEFAULT_CONFIG.growthWindowDays).toBe(30)
    expect(DEFAULT_CONFIG.growthAbsoluteFloor).toBe(50)
  })

  it('honors an overridden floor (radar may differ from showcase)', () => {
    // With a floor of 1, a base of 3 → 6 now reports a real percentage.
    const curve = [curvePt('2026-05-10', 3), curvePt('2026-06-09', 6)]
    expect(growthOverWindow(curve, 30, 1).growthPct).toBeCloseTo(1.0, 6)
  })
})
