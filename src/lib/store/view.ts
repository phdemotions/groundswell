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
