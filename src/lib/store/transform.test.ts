import { describe, expect, it } from 'vitest'

import type { Release, ReleaseAsset, StargazerEvent } from '../github/types'
import type { Snapshot } from './types'
import {
  buildCadence,
  buildStarEvents,
  releaseMap,
  sumDownloads,
  upsertSnapshotLines,
} from './transform'

function asset(downloadCount: number): ReleaseAsset {
  return {
    id: 1,
    name: 'a',
    contentType: '',
    size: 0,
    downloadCount,
    createdAt: null,
    updatedAt: null,
  }
}

function rel(partial: Partial<Release>): Release {
  return {
    id: 1,
    tagName: 'v1',
    name: null,
    draft: false,
    prerelease: false,
    createdAt: null,
    publishedAt: null,
    assets: [],
    ...partial,
  }
}

describe('sumDownloads', () => {
  it('sums every non-draft release asset', () => {
    expect(
      sumDownloads([rel({ assets: [asset(10), asset(5)] }), rel({ assets: [asset(3)] })])
    ).toBe(18)
  })

  it('excludes drafts', () => {
    expect(
      sumDownloads([
        rel({ assets: [asset(10)] }),
        rel({ draft: true, assets: [asset(99)] }),
      ])
    ).toBe(10)
  })

  it('is zero with no releases', () => {
    expect(sumDownloads([])).toBe(0)
  })
})

describe('releaseMap', () => {
  it('maps tag → summed asset downloads, excluding drafts + empty tags', () => {
    expect(
      releaseMap([
        rel({ tagName: 'v1.0.0', assets: [asset(17)] }),
        rel({ tagName: 'v1.3.0', assets: [asset(200), asset(74)] }),
        rel({ tagName: 'draft', draft: true, assets: [asset(5)] }),
        rel({ tagName: '', assets: [asset(9)] }),
      ])
    ).toEqual({ 'v1.0.0': 17, 'v1.3.0': 274 })
  })
})

describe('buildCadence', () => {
  it('sorts by publishedAt and excludes drafts + missing dates', () => {
    expect(
      buildCadence([
        rel({ tagName: 'v2', publishedAt: '2026-06-08T00:00:00Z' }),
        rel({ tagName: 'v1', publishedAt: '2026-04-06T00:00:00Z' }),
        rel({ tagName: 'd', draft: true, publishedAt: '2026-05-01T00:00:00Z' }),
        rel({ tagName: 'np', publishedAt: null }),
      ])
    ).toEqual([
      { tag: 'v1', publishedAt: '2026-04-06T00:00:00Z' },
      { tag: 'v2', publishedAt: '2026-06-08T00:00:00Z' },
    ])
  })
})

describe('buildStarEvents', () => {
  it('keeps only real starred_at timestamps, sorted', () => {
    const stars: StargazerEvent[] = [
      { login: 'b', starredAt: '2026-05-01T00:00:00Z' },
      { login: 'a', starredAt: '2026-04-01T00:00:00Z' },
      { login: 'c', starredAt: null },
    ]
    expect(buildStarEvents(stars)).toEqual([
      { at: '2026-04-01T00:00:00Z' },
      { at: '2026-05-01T00:00:00Z' },
    ])
  })
})

describe('upsertSnapshotLines', () => {
  const snap = (d: string, downloads: number): Snapshot => ({
    d,
    capturedAt: `${d}T04:00:00.000Z`,
    downloads,
    stars: 0,
    forks: 0,
    watchers: 0,
    releases: {},
  })

  it('overwrites the line for the same UTC day', () => {
    const out = upsertSnapshotLines(
      [JSON.stringify(snap('2026-06-11', 100))],
      snap('2026-06-11', 200)
    )
    expect(out).toHaveLength(1)
    expect((JSON.parse(out[0]) as Snapshot).downloads).toBe(200)
  })

  it('appends a new day and stays chronological', () => {
    const out = upsertSnapshotLines(
      [JSON.stringify(snap('2026-06-11', 100))],
      snap('2026-06-10', 90)
    )
    expect(out.map((l) => (JSON.parse(l) as Snapshot).d)).toEqual([
      '2026-06-10',
      '2026-06-11',
    ])
  })

  it('preserves malformed lines rather than dropping them', () => {
    const out = upsertSnapshotLines(['not json'], snap('2026-06-11', 1))
    expect(out).toContain('not json')
    expect(out).toHaveLength(2)
  })
})
