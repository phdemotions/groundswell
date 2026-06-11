/**
 * Showcase store reader — U8′ (static-first).
 *
 * Loads the COMMITTED public JSON store (data/meta.json + data/<name>.ndjson +
 * data/backfill/<name>.json) at build time for the static showcase. Thin I/O —
 * the pure mapping into the view-model is `buildShowcaseModel` in `view.ts`.
 *
 * PRIVACY (CLAUDE.md / GS-010): this reader loads ONLY `visibility: 'public'`
 * repos and never reads `data/.local/`. The public build therefore CANNOT embed
 * private-repo metrics — private repos reach the showcase only as name/tagline/
 * status "Shipping next" entries, sourced from meta.json (the `pipeline`).
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Backfill, Meta, Snapshot, TrackedRepo } from './types'

/** Default store location: the committed `data/` dir at the repo root (build cwd). */
const DEFAULT_DATA_DIR = join(process.cwd(), 'data')

/** One public repo's loaded store: its meta row + snapshot history + backfill. */
export interface RepoData {
  repo: TrackedRepo
  snapshots: Snapshot[]
  backfill: Backfill | null
}

/** The loaded public store: roster + per-public-repo data. */
export interface RawStore {
  meta: Meta
  public: RepoData[]
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf8')) as T
}

/** Parse NDJSON to snapshots, skipping blank/malformed lines (defensive). */
function parseNdjson(text: string): Snapshot[] {
  const out: Snapshot[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line) as Snapshot)
    } catch {
      // Skip a hand-edited bad line rather than failing the whole build.
    }
  }
  return out
}

/**
 * Load the public showcase store. Reads meta.json, then for each PUBLIC repo its
 * snapshot NDJSON + backfill JSON. Private repos are skipped entirely (their data
 * lives in gitignored data/.local/ and is never read here).
 */
export async function loadShowcaseStore(
  dataDir: string = DEFAULT_DATA_DIR
): Promise<RawStore> {
  const meta = await readJson<Meta>(join(dataDir, 'meta.json'))
  if (meta === null) {
    throw new Error(`loadShowcaseStore: ${join(dataDir, 'meta.json')} not found`)
  }

  const pub: RepoData[] = []
  for (const repo of meta.repos) {
    if (repo.visibility !== 'public') continue // privacy: never read data/.local
    const ndjsonPath = join(dataDir, `${repo.name}.ndjson`)
    const snapshots = existsSync(ndjsonPath)
      ? parseNdjson(await readFile(ndjsonPath, 'utf8'))
      : []
    const backfill = await readJson<Backfill>(
      join(dataDir, 'backfill', `${repo.name}.json`)
    )
    pub.push({ repo, snapshots, backfill })
  }

  return { meta, public: pub }
}
