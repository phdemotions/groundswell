/**
 * Pure transforms for the JSON store (U4′ static-first capture).
 *
 * The capture script (`scripts/capture.ts`) is thin I/O; all the logic that maps
 * parsed GitHub domain objects → on-disk `Snapshot` / `Backfill` shapes lives
 * here as PURE functions so it is unit-testable without network or filesystem
 * (mirrors the derive.ts / capture.ts split from the v1 architecture).
 */

import type { Release, RepoSummary, StargazerEvent } from '../github/types'
import type { Backfill, Snapshot } from './types'

/** Sum of every NON-draft release asset's cumulative `download_count`. */
export function sumDownloads(releases: Release[]): number {
  let total = 0
  for (const r of releases) {
    if (r.draft) continue
    for (const a of r.assets) total += a.downloadCount
  }
  return total
}

/**
 * Cumulative downloads per release tag (the showcase bars). Drafts and
 * empty-tag releases are excluded. A tag's value is the sum of its assets.
 */
export function releaseMap(releases: Release[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const r of releases) {
    if (r.draft || r.tagName.length === 0) continue
    map[r.tagName] = r.assets.reduce((s, a) => s + a.downloadCount, 0)
  }
  return map
}

/** Ship-cadence: each non-draft, published release's tag + date, chronological. */
export function buildCadence(releases: Release[]): Backfill['cadence'] {
  return releases
    .filter((r) => !r.draft && r.publishedAt !== null && r.tagName.length > 0)
    .map((r) => ({ tag: r.tagName, publishedAt: r.publishedAt as string }))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
}

/** Star events with a real `starred_at` (EventPoint), chronological. */
export function buildStarEvents(stars: StargazerEvent[]): Backfill['stars'] {
  return stars
    .filter((s) => s.starredAt !== null)
    .map((s) => ({ at: s.starredAt as string }))
    .sort((a, b) => a.at.localeCompare(b.at))
}

/** Assemble one daily cumulative snapshot from parsed GitHub objects. */
export function buildSnapshot(
  summary: RepoSummary,
  releases: Release[],
  capturedAt: string
): Snapshot {
  return {
    d: capturedAt.slice(0, 10),
    capturedAt,
    downloads: sumDownloads(releases),
    stars: summary.stars,
    forks: summary.forks,
    watchers: summary.watchers,
    releases: releaseMap(releases),
  }
}

/** Assemble the reconstructable backfill (stars + ship-cadence). */
export function buildBackfill(
  stars: StargazerEvent[],
  releases: Release[],
  generatedAt: string
): Backfill {
  return {
    generatedAt,
    stars: buildStarEvents(stars),
    cadence: buildCadence(releases),
  }
}

/**
 * Upsert today's snapshot into the existing NDJSON lines: drop any line for the
 * same UTC day (a same-day re-run overwrites), append the new one, return sorted
 * chronological. PURE — the file read/write lives in capture.ts. Malformed lines
 * are preserved rather than silently dropped (defensive against hand-edits).
 */
export function upsertSnapshotLines(
  existingLines: string[],
  snap: Snapshot
): string[] {
  const kept = existingLines
    .filter((l) => l.trim().length > 0)
    .filter((l) => {
      try {
        return (JSON.parse(l) as Snapshot).d !== snap.d
      } catch {
        return true
      }
    })
  kept.push(JSON.stringify(snap))
  return kept.sort((a, b) => snapDay(a).localeCompare(snapDay(b)))
}

function snapDay(line: string): string {
  try {
    return (JSON.parse(line) as Snapshot).d
  } catch {
    return ''
  }
}
