/**
 * U4′ capture — fetch GitHub signals → JSON store (static-first pivot).
 *
 * Run daily by `.github/workflows/capture.yml` (and locally via `pnpm capture`).
 * Reuses the U3 `GitHubClient` (typed, rate-aware, paginated). Pure mapping logic
 * lives in `src/lib/store/transform.ts`; this script is thin I/O. It writes:
 *
 *   data/<name>.ndjson        append/overwrite today's cumulative snapshot line
 *   data/backfill/<name>.json regenerated reconstructable history (stars + cadence)
 *   data/meta.json            lastCapture timestamp bumped
 *
 * Git history of data/<name>.ndjson IS the time-series log. A same-UTC-day re-run
 * OVERWRITES that day's line (the JSON analog of ON CONFLICT (repo, day)).
 *
 * PRIVACY (CLAUDE.md / GS-010): public repos → committed `data/`; private repos →
 * gitignored `data/.local/`. Private-repo metrics never enter committed JSON.
 *
 * Auth: a fine-grained PAT in `GH_PAT` (Administration:Read + Contents:Read +
 * Metadata:Read). Falls back to `GITHUB_TOKEN` for local runs.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GitHubClient } from '../src/lib/github/client'
import type { Backfill, Meta, Snapshot, TrackedRepo } from '../src/lib/store/types'
import {
  buildBackfill,
  buildSnapshot,
  upsertSnapshotLines,
} from '../src/lib/store/transform'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'data')

/** public → committed `data/`; private → gitignored `data/.local/` (privacy). */
function storeDir(repo: TrackedRepo): string {
  return repo.visibility === 'public' ? DATA : join(DATA, '.local')
}

async function readMeta(): Promise<Meta> {
  return JSON.parse(await readFile(join(DATA, 'meta.json'), 'utf8')) as Meta
}

/** Append today's snapshot to data/<name>.ndjson, overwriting any same-day line. */
async function writeSnapshot(repo: TrackedRepo, snap: Snapshot): Promise<void> {
  const dir = storeDir(repo)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${repo.name}.ndjson`)
  const existing = existsSync(file)
    ? (await readFile(file, 'utf8')).split('\n')
    : []
  const lines = upsertSnapshotLines(existing, snap)
  await writeFile(file, lines.join('\n') + '\n', 'utf8')
}

async function writeBackfill(repo: TrackedRepo, bf: Backfill): Promise<void> {
  const dir = join(storeDir(repo), 'backfill')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${repo.name}.json`),
    JSON.stringify(bf, null, 2) + '\n',
    'utf8'
  )
}

async function captureRepo(
  client: GitHubClient,
  repo: TrackedRepo,
  capturedAt: string
): Promise<Snapshot> {
  const [summary, releases, stars] = await Promise.all([
    client.getRepoSummary(repo.owner, repo.repo),
    client.listReleases(repo.owner, repo.repo),
    client.listStargazers(repo.owner, repo.repo),
  ])
  const snap = buildSnapshot(summary, releases, capturedAt)
  await writeSnapshot(repo, snap)
  await writeBackfill(repo, buildBackfill(stars, releases, capturedAt))
  return snap
}

async function main(): Promise<void> {
  const token = process.env.GH_PAT ?? process.env.GITHUB_TOKEN
  if (!token) {
    console.error('capture: missing GH_PAT (or GITHUB_TOKEN) in env')
    process.exit(1)
  }

  // Private repos need a token that can READ them (a local `gh auth token` or a
  // fine-grained PAT). CI's built-in GITHUB_TOKEN can't read other private repos
  // (it 404s), and their metrics would only go to gitignored data/.local anyway.
  // So capture PRIVATE repos ONLY when explicitly opted in — the public CI capture
  // skips them and succeeds; a local radar run sets CAPTURE_PRIVATE=1.
  const includePrivate =
    process.env.CAPTURE_PRIVATE === '1' || process.env.CAPTURE_PRIVATE === 'true'

  const client = new GitHubClient({ token })
  const meta = await readMeta()
  const capturedAt = new Date().toISOString()

  let failed = 0
  for (const repo of meta.repos) {
    if (repo.visibility === 'private' && !includePrivate) {
      console.log(`· ${repo.name} (private) → skipped (set CAPTURE_PRIVATE=1 to include)`)
      continue
    }
    try {
      const snap = await captureRepo(client, repo, capturedAt)
      console.log(
        `✓ ${repo.name} (${repo.visibility}) → downloads=${snap.downloads} ` +
          `stars=${snap.stars} forks=${snap.forks} watchers=${snap.watchers} ` +
          `releases=${Object.keys(snap.releases).length}`
      )
    } catch (err) {
      failed += 1
      console.error(`✗ ${repo.name}: ${err instanceof Error ? err.message : err}`)
    }
  }

  meta.lastCapture = capturedAt
  await writeFile(
    join(DATA, 'meta.json'),
    JSON.stringify(meta, null, 2) + '\n',
    'utf8'
  )
  console.log(`meta.lastCapture = ${capturedAt}`)

  // A partial run still commits the repos that succeeded, but exits non-zero so
  // the Action surfaces the failure.
  if (failed > 0) process.exit(1)
}

void main()
