import { describe, expect, it } from 'vitest'

import type { RawStore } from './read'
import type { Backfill, Meta, Snapshot, TrackedRepo } from './types'
import { buildReleaseChart, buildShowcaseModel, type ReleaseBar } from './view'

function repo(partial: Partial<TrackedRepo> & Pick<TrackedRepo, 'name' | 'visibility'>): TrackedRepo {
  return {
    owner: 'phdemotions',
    repo: partial.name,
    displayName: partial.name,
    tagline: `${partial.name} tagline`,
    homepageUrl: null,
    trackingStartedAt: '2026-06-11',
    ...partial,
  }
}

function snap(partial: Partial<Snapshot> & Pick<Snapshot, 'd' | 'downloads'>): Snapshot {
  return {
    capturedAt: `${partial.d}T04:00:00.000Z`,
    stars: 0,
    forks: 0,
    watchers: 0,
    releases: {},
    ...partial,
  }
}

const CITEGEIST_BACKFILL: Backfill = {
  generatedAt: '2026-06-11T04:00:00.000Z',
  stars: [
    { at: '2026-04-05T00:00:00Z' },
    { at: '2026-05-01T00:00:00Z' },
    { at: '2026-06-07T00:00:00Z' },
  ],
  cadence: [
    { tag: 'v1.0.0', publishedAt: '2026-04-06T00:00:00Z' },
    { tag: 'v1.3.0', publishedAt: '2026-04-19T00:00:00Z' },
    { tag: 'v2.0.0', publishedAt: '2026-06-08T00:00:00Z' },
  ],
}

function fixture(): RawStore {
  const meta: Meta = {
    repos: [
      repo({ name: 'citegeist', repo: 'zotero-citegeist', visibility: 'public' }),
      repo({ name: 'provenance', visibility: 'private', tagline: 'cited drafts' }),
    ],
    lastCapture: '2026-06-11T04:00:00.000Z',
  }
  return {
    meta,
    public: [
      {
        repo: meta.repos[0],
        snapshots: [
          snap({
            d: '2026-06-11',
            downloads: 576,
            stars: 10,
            releases: { 'v1.0.0': 17, 'v1.3.0': 274, zero: 0, 'v2.0.0': 61 },
          }),
        ],
        backfill: CITEGEIST_BACKFILL,
      },
    ],
  }
}

describe('buildShowcaseModel', () => {
  it('puts public repos in projects and private repos in pipeline', () => {
    const m = buildShowcaseModel(fixture())
    expect(m.projects.map((p) => p.name)).toEqual(['citegeist'])
    expect(m.pipeline).toEqual([
      { displayName: 'provenance', tagline: 'cited drafts', status: 'in progress · private' },
    ])
  })

  it('derives the hero aggregate from the store (no hardcoding)', () => {
    const m = buildShowcaseModel(fixture())
    expect(m.hero.totalDownloads).toBe(576)
    expect(m.hero.totalStars).toBe(10)
    expect(m.hero.leadProjectName).toBe('citegeist')
    expect(m.generatedAt).toBe('2026-06-11T04:00:00.000Z')
  })

  it('builds release bars: drops zero-download releases, orders by ship date', () => {
    const bars = buildShowcaseModel(fixture()).projects[0].releaseBars
    expect(bars.map((b) => b.tag)).toEqual(['v1.0.0', 'v1.3.0', 'v2.0.0'])
    expect(bars.map((b) => b.downloads)).toEqual([17, 274, 61])
    expect(bars.every((b) => b.downloads > 0)).toBe(true)
  })

  it('builds a cumulative stars curve from the backfill', () => {
    const curve = buildShowcaseModel(fixture()).projects[0].starsCurve
    expect(curve.at(-1)?.cumulative).toBe(3)
    expect(curve.map((p) => p.cumulative)).toEqual([1, 2, 3])
  })

  it('marks a single-snapshot download series as tracking_started', () => {
    const downloads = buildShowcaseModel(fixture()).projects[0].downloads
    expect(downloads.status).toBe('tracking_started')
    expect(downloads.latest).toBe(576)
  })
})

describe('buildReleaseChart', () => {
  const TEAL = 'var(--viz-cat-1)'
  const BLUE = 'var(--viz-cat-2)'
  const OTHER = 'var(--ink-300)'
  const bar = (tag: string, downloads: number, publishedAt: string | null): ReleaseBar => ({
    tag,
    downloads,
    publishedAt,
  })
  const sample: ReleaseBar[] = [
    bar('v1.0.0', 17, '2026-04-06T00:00:00Z'),
    bar('v1.3.0', 274, '2026-04-19T00:00:00Z'),
    bar('v2.0.0', 61, '2026-06-08T00:00:00Z'),
    bar('v2.0.2', 116, '2026-06-09T00:00:00Z'),
  ]

  it('accents the latest major, secondary-tones earlier majors', () => {
    expect(buildReleaseChart(sample).bars.map((b) => b.color)).toEqual([BLUE, BLUE, TEAL, TEAL])
  })

  it('groups by contiguous major run with a ship-month sublabel', () => {
    expect(buildReleaseChart(sample).groups).toEqual([
      { label: 'Version 1', sublabel: 'Apr', fromIndex: 0, toIndex: 1, color: BLUE },
      { label: 'Version 2', sublabel: 'Jun', fromIndex: 2, toIndex: 3, color: TEAL },
    ])
  })

  it("value-labels each group's tallest bar only", () => {
    expect(buildReleaseChart(sample).bars.map((b) => b.showValue)).toEqual([
      false,
      true,
      false,
      true,
    ])
  })

  it('treats a lone un-versioned tag as its own muted group', () => {
    const { bars, groups } = buildReleaseChart([bar('release', 15, '2026-06-08T00:00:00Z')])
    expect(bars[0].color).toBe(OTHER)
    expect(groups[0].label).toBe('Other')
  })

  it('absorbs an un-versioned tag into the surrounding major run (no fragmenting)', () => {
    const { bars, groups } = buildReleaseChart([
      bar('v2.0.0', 61, '2026-06-08T00:00:00Z'),
      bar('release', 16, '2026-06-08T00:00:00Z'),
      bar('v2.0.1', 23, '2026-06-08T00:00:00Z'),
    ])
    expect(bars.map((b) => b.color)).toEqual([TEAL, TEAL, TEAL])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Version 2')
  })

  it('collapses a single major to one accented group', () => {
    const { bars, groups } = buildReleaseChart([
      bar('v1.0.0', 5, '2026-04-06T00:00:00Z'),
      bar('v1.1.0', 9, '2026-04-09T00:00:00Z'),
    ])
    expect(bars.every((b) => b.color === TEAL)).toBe(true)
    expect(groups).toHaveLength(1)
  })
})
