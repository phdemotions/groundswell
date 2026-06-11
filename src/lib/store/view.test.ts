import { describe, expect, it } from 'vitest'

import type { RawStore } from './read'
import type { Backfill, Meta, Snapshot, TrackedRepo } from './types'
import { buildShowcaseModel } from './view'

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
