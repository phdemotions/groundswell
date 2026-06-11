import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Meta } from './types'

/**
 * GS-010 privacy guard. The committed `data/` store must expose PUBLIC repos
 * ONLY; private-repo metrics live in gitignored `data/.local/` and must never be
 * committed (CLAUDE.md privacy boundary). This test fails if a private repo's
 * snapshot/backfill appears in the committed store, or if a committed snapshot
 * doesn't map to a public repo — catching a misrouted capture or a repo flipped
 * to private without its data being purged.
 */
const DATA = join(process.cwd(), 'data')
const meta = JSON.parse(readFileSync(join(DATA, 'meta.json'), 'utf8')) as Meta

const privateRepos = meta.repos.filter((r) => r.visibility === 'private')
const publicNames = new Set(
  meta.repos.filter((r) => r.visibility === 'public').map((r) => r.name)
)

describe('GS-010: committed data exposes public repos only', () => {
  it.each(privateRepos.map((r) => r.name))(
    'does not commit private repo "%s" metrics to data/',
    (name) => {
      expect(existsSync(join(DATA, `${name}.ndjson`))).toBe(false)
      expect(existsSync(join(DATA, 'backfill', `${name}.json`))).toBe(false)
    }
  )

  it('every committed *.ndjson belongs to a public repo', () => {
    const committed = readdirSync(DATA).filter((f) => f.endsWith('.ndjson'))
    expect(committed.length).toBeGreaterThan(0)
    for (const file of committed) {
      expect(publicNames.has(file.replace(/\.ndjson$/, ''))).toBe(true)
    }
  })
})
