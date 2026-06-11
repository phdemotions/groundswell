/**
 * Showcase view-model — U8′ (static-first).
 *
 * PURE transform from the loaded store (`RawStore`) into the exact shape the U10
 * showcase renders. All numbers come from `derive.ts` over the JSON store — no
 * hardcoded figures (CLAUDE.md Product invariant #1). Unit-tested in view.test.ts.
 *
 * Split of responsibility:
 *   - read.ts   → I/O (load committed public store)
 *   - view.ts   → pure mapping (this file) using derive.ts
 *   - U10 page  → render this model
 */

import {
  aggregateLatestTotal,
  cumulativeCurve,
  DEFAULT_CONFIG,
  deriveCumulativeMetric,
  eventCumulativeCurve,
  type CurvePoint,
  type DeriveConfig,
  type MetricSummary,
} from '../metrics/derive'
import type { RawStore, RepoData } from './read'
import type { Backfill, Visibility } from './types'

/** "Shipping next" status for a private / in-progress repo. */
const PIPELINE_STATUS = 'in progress · private'

/** One release's bar: tag, its cumulative downloads, and when it shipped. */
export interface ReleaseBar {
  tag: string
  downloads: number
  /** ISO ship date (from cadence), or null when not matched. */
  publishedAt: string | null
}

/** A public, earned project rendered with full metrics + curves. */
export interface ShowcaseProject {
  name: string
  displayName: string
  tagline: string
  visibility: Visibility
  homepageUrl: string | null
  /** Cold-start anchor: when live snapshot tracking began. */
  trackingStartedAt: string
  /** Derived download summary (latest, velocity, growth, degradation status). */
  downloads: MetricSummary
  /** Latest stars count. */
  stars: number
  /** Per-release bars — downloads>0 only, ordered by ship date (chronological). */
  releaseBars: ReleaseBar[]
  /** Backfilled cumulative stars-over-time curve (real history). */
  starsCurve: CurvePoint[]
  /** Cumulative downloads-over-time curve (sparse until snapshots accrue). */
  downloadsCurve: CurvePoint[]
  /** Ship-cadence: each release's tag + publish date. */
  cadence: Backfill['cadence']
  /** Total published releases (incl. zero-download) — the cadence headline. */
  releaseCount: number
  /** Most recent release (tag + ISO date), or null. */
  latestRelease: { tag: string; publishedAt: string } | null
}

/** A "Shipping next" item — private/in-progress, NO metrics (honesty). */
export interface PipelineItem {
  displayName: string
  tagline: string
  status: string
}

/** The whole showcase, derived from the store. */
export interface ShowcaseModel {
  /** meta.lastCapture — the "as of" stamp; null before the first capture. */
  generatedAt: string | null
  hero: {
    /** Absolute aggregate across public projects (KTD12 honest anchor). */
    totalDownloads: number
    totalStars: number
    /** The loud lead project's `name` (most downloads), or null. */
    leadProjectName: string | null
  }
  /** Public, earned projects (the showcase body). */
  projects: ShowcaseProject[]
  /** Private / in-progress repos (the "Shipping next" cards). */
  pipeline: PipelineItem[]
}

/** Latest snapshot by UTC day (the most recent capture). */
function latestSnapshot(rd: RepoData) {
  if (rd.snapshots.length === 0) return null
  return [...rd.snapshots].sort((a, b) => a.d.localeCompare(b.d)).at(-1) ?? null
}

/**
 * Per-release bars from the latest snapshot's release map, joined to ship dates,
 * filtered to downloads>0 (drop zero-download releases), ordered chronologically
 * by ship date (the April→June timeline). Real data is messy — this is where the
 * stray/zero releases get filtered, not in the chart.
 */
function buildReleaseBars(
  rd: RepoData,
  cadence: Backfill['cadence']
): ReleaseBar[] {
  const latest = latestSnapshot(rd)
  if (latest === null) return []
  const shippedAt = new Map(cadence.map((c) => [c.tag, c.publishedAt]))
  return Object.entries(latest.releases)
    .map(([tag, downloads]) => ({
      tag,
      downloads,
      publishedAt: shippedAt.get(tag) ?? null,
    }))
    .filter((b) => b.downloads > 0)
    .sort((a, b) => {
      if (a.publishedAt !== null && b.publishedAt !== null) {
        return a.publishedAt.localeCompare(b.publishedAt)
      }
      if (a.publishedAt !== null) return -1
      if (b.publishedAt !== null) return 1
      return a.tag.localeCompare(b.tag)
    })
}

function buildProject(rd: RepoData, config: DeriveConfig): ShowcaseProject {
  const latest = latestSnapshot(rd)
  const downloadPoints = rd.snapshots.map((s) => ({
    capturedAt: s.capturedAt,
    cumulative: s.downloads,
  }))
  const cadence = rd.backfill?.cadence ?? []

  return {
    name: rd.repo.name,
    displayName: rd.repo.displayName,
    tagline: rd.repo.tagline,
    visibility: rd.repo.visibility,
    homepageUrl: rd.repo.homepageUrl,
    trackingStartedAt: rd.repo.trackingStartedAt,
    downloads: deriveCumulativeMetric(downloadPoints, config),
    stars: latest?.stars ?? 0,
    releaseBars: buildReleaseBars(rd, cadence),
    starsCurve: eventCumulativeCurve((rd.backfill?.stars ?? []).map((e) => ({ at: e.at }))),
    downloadsCurve: cumulativeCurve(downloadPoints),
    cadence,
    releaseCount: cadence.length,
    latestRelease: cadence.at(-1) ?? null,
  }
}

/**
 * Build the whole showcase model from the loaded store. Public repos become
 * full `projects` (+ the hero aggregate); private repos become `pipeline` items
 * (name/tagline/status only — never metrics).
 */
export function buildShowcaseModel(
  store: RawStore,
  config: DeriveConfig = DEFAULT_CONFIG
): ShowcaseModel {
  const projects = store.public.map((rd) => buildProject(rd, config))

  const totalDownloads = aggregateLatestTotal(
    projects.map((p) => ({ projectId: p.name, curve: p.downloadsCurve }))
  )
  const totalStars = projects.reduce((sum, p) => sum + p.stars, 0)
  const lead =
    [...projects].sort((a, b) => b.downloads.latest - a.downloads.latest).at(0) ??
    null

  const pipeline: PipelineItem[] = store.meta.repos
    .filter((r) => r.visibility === 'private')
    .map((r) => ({
      displayName: r.displayName,
      tagline: r.tagline,
      status: PIPELINE_STATUS,
    }))

  return {
    generatedAt: store.meta.lastCapture,
    hero: {
      totalDownloads,
      totalStars,
      leadProjectName: lead?.name ?? null,
    },
    projects,
    pipeline,
  }
}

// ============================================================================
// Release-bar chart derivation (general, data-driven — no per-repo hardcoding)
// ============================================================================

/** Latest-major releases get the accent; earlier majors a secondary tone. */
const VIZ_LATEST = 'var(--viz-cat-1)' // swell teal — the current major
const VIZ_PRIOR = 'var(--viz-cat-2)' //  harbor blue — earlier majors
const VIZ_OTHER = 'var(--ink-300)' //    un-versioned tags (e.g. a stray "release")

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A release bar prepared for the chart: color + whether to print its value. */
export interface ChartBar {
  label: string
  value: number
  color: string
  showValue: boolean
}

/** A contiguous major-version run, for the group span labels under the bars. */
export interface ChartGroup {
  label: string
  /** Month (or month range) the run shipped in, e.g. "Apr" or "Apr–Jun". */
  sublabel: string
  fromIndex: number
  toIndex: number
  color: string
}

export interface ReleaseChart {
  bars: ChartBar[]
  groups: ChartGroup[]
}

/** Major version from a tag (`v2.0.4` → 2), or null for un-versioned tags. */
function majorOf(tag: string): number | null {
  const m = /^v?(\d+)\./.exec(tag)
  return m ? Number.parseInt(m[1], 10) : null
}

function shortMonth(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return MONTHS_SHORT[new Date(ms).getUTCMonth()]
}

function colorForMajor(major: number | null, latestMajor: number | null): string {
  if (major === null) return VIZ_OTHER
  return major === latestMajor ? VIZ_LATEST : VIZ_PRIOR
}

/**
 * Turn ordered release bars into a colored, grouped chart spec — GENERAL, not
 * citegeist-specific: the newest major version is accented, earlier majors are
 * secondary, runs of the same major become group bands labeled with their ship
 * month(s), and each group's tallest bar is value-labeled. A repo with one major
 * collapses to a single tone + band; a repo with five majors still reads as
 * "current vs prior". `bars` must already be in chronological (ship) order.
 */
export function buildReleaseChart(bars: ReleaseBar[]): ReleaseChart {
  const majors = bars.map((b) => majorOf(b.tag))
  const latestMajor = majors.reduce<number | null>(
    (mx, m) => (m !== null && (mx === null || m > mx) ? m : mx),
    null
  )

  // Effective major for GROUPING: an un-versioned tag (e.g. a stray "release")
  // inherits the surrounding major (forward-fill, then back-fill leading gaps) so
  // it blends into a version's run instead of fragmenting it into separate bands.
  const eff = [...majors]
  let prev: number | null = null
  for (let k = 0; k < eff.length; k++) {
    if (eff[k] === null) eff[k] = prev
    else prev = eff[k]
  }
  let next: number | null = null
  for (let k = eff.length - 1; k >= 0; k--) {
    if (eff[k] === null) eff[k] = next
    else next = eff[k]
  }

  const chartBars: ChartBar[] = bars.map((b, i) => ({
    label: b.tag,
    value: b.downloads,
    color: colorForMajor(eff[i], latestMajor),
    showValue: false,
  }))

  // Contiguous runs of the same effective major → group bands.
  const groups: ChartGroup[] = []
  let i = 0
  while (i < bars.length) {
    let j = i
    while (j + 1 < bars.length && eff[j + 1] === eff[i]) j++
    const runMonths = bars
      .slice(i, j + 1)
      .map((b) => b.publishedAt)
      .filter((d): d is string => d !== null)
      .map(shortMonth)
      .filter((m) => m.length > 0)
    const sublabel =
      runMonths.length === 0
        ? ''
        : runMonths[0] === runMonths[runMonths.length - 1]
          ? runMonths[0]
          : `${runMonths[0]}–${runMonths[runMonths.length - 1]}`
    groups.push({
      label: eff[i] === null ? 'Other' : `Version ${eff[i]}`,
      sublabel,
      fromIndex: i,
      toIndex: j,
      color: colorForMajor(eff[i], latestMajor),
    })
    i = j + 1
  }

  // Value-label each group's tallest (nonzero) bar.
  for (const g of groups) {
    let maxIndex = g.fromIndex
    for (let k = g.fromIndex + 1; k <= g.toIndex; k++) {
      if (chartBars[k].value > chartBars[maxIndex].value) maxIndex = k
    }
    if (chartBars[maxIndex].value > 0) chartBars[maxIndex].showValue = true
  }

  return { bars: chartBars, groups }
}
