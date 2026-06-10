import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * CI-enforced barrier on the Supabase service-role admin client.
 *
 * `@/lib/supabase/admin` exposes `getAdmin()` — a Supabase client built with
 * SUPABASE_SERVICE_ROLE_KEY that bypasses RLS entirely. The service-role key
 * MUST never reach the browser bundle.
 *
 * Server Components, Server Actions, Route Handlers, and src/lib/** may
 * legitimately import the admin client (the capture path, authorized reads).
 * The dangerous case is a file carrying the `'use client'` directive that
 * imports it — Next.js ships such code to the browser, leaking the key. This
 * test catches that case specifically.
 *
 * It complements two static guards: the `server-only` import in admin.ts (build
 * fails if bundled client-side) and the eslint `no-restricted-imports` rule on
 * the (public) route group.
 */

const PROJECT_ROOT = join(__dirname, '..')

// Match every shape that could ship the admin client into a 'use client' file:
//   - static `import ... from '@/lib/supabase/admin'` (alias)
//   - relative path with any number of `..` segments
//   - explicit `.ts`/`.tsx` extensions
//   - dynamic `await import('@/lib/supabase/admin')`
//   - bare side-effect `import '@/lib/supabase/admin'`
//   - CommonJS `require('@/lib/supabase/admin')`
// `import type { ... }` is intentionally excluded — type-only imports are erased
// at compile time and pose no runtime leak risk.
const ADMIN_PATH_RE = /(?:@\/|(?:\.\.?\/)+)lib\/supabase\/admin(?:\.tsx?)?/
const ADMIN_IMPORT_PATTERNS = [
  new RegExp(`from\\s+['"]${ADMIN_PATH_RE.source}['"]`),
  new RegExp(`import\\s*\\(\\s*['"]${ADMIN_PATH_RE.source}['"]`),
  new RegExp(`^\\s*import\\s+['"]${ADMIN_PATH_RE.source}['"]`),
  new RegExp(`require\\s*\\(\\s*['"]${ADMIN_PATH_RE.source}['"]`),
]

const SCAN_ROOTS = ['src/app', 'src/components']
const EXCLUDE_DIRS = ['node_modules', '.next', '.vercel']

interface Violation {
  file: string
  importLine: number
  importText: string
}

function listFiles(dir: string): string[] {
  const files: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const rel = relative(PROJECT_ROOT, full)
    if (EXCLUDE_DIRS.some((ex) => rel === ex || rel.startsWith(`${ex}/`))) continue

    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      files.push(...listFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

/** First non-empty, non-comment line, trailing semicolon stripped so
 * `'use client';` and `'use client'` normalize to the same value. */
function firstDirective(content: string): string | null {
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (
      line === '' ||
      line.startsWith('//') ||
      line.startsWith('/*') ||
      line.startsWith('*')
    )
      continue
    return line.replace(/;\s*$/, '')
  }
  return null
}

function scanFile(file: string): Violation[] {
  const content = readFileSync(file, 'utf8')
  const directive = firstDirective(content)

  if (directive !== `'use client'` && directive !== `"use client"`) {
    return []
  }

  const lines = content.split('\n')
  const violations: Violation[] = []
  for (let i = 0; i < lines.length; i++) {
    if (ADMIN_IMPORT_PATTERNS.some((p) => p.test(lines[i]))) {
      violations.push({
        file: relative(PROJECT_ROOT, file),
        importLine: i + 1,
        importText: lines[i].trim(),
      })
    }
  }
  return violations
}

describe('service-role admin client browser-bundle barrier', () => {
  it('@/lib/supabase/admin is never imported by a "use client" file', () => {
    const allViolations: Violation[] = []

    for (const root of SCAN_ROOTS) {
      const files = listFiles(join(PROJECT_ROOT, root))
      for (const file of files) {
        if (file === __filename) continue
        allViolations.push(...scanFile(file))
      }
    }

    if (allViolations.length > 0) {
      const formatted = allViolations
        .map((v) => `  ${v.file}:${v.importLine}\n    ${v.importText}`)
        .join('\n')
      throw new Error(
        `Forbidden import of @/lib/supabase/admin in a 'use client' file.\n` +
          `The service-role key MUST never reach the browser bundle. Either:\n` +
          `  - Drop the 'use client' directive (run as a Server Component)\n` +
          `  - Move admin-using logic to a Server Action ('use server')\n` +
          `  - Move admin-using logic to a Route Handler under src/app/api/**\n\n` +
          `Violations:\n${formatted}`
      )
    }

    expect(allViolations).toEqual([])
  })

  it('the detection regex actually matches a client-context admin import', () => {
    // Positive control — guards against the barrier silently rotting into a
    // no-op (e.g. if the import-path shape changes and the regex stops matching).
    const sample = [`'use client'`, `import { getAdmin } from '@/lib/supabase/admin'`].join('\n')
    const directive = firstDirective(sample)
    expect(directive).toBe(`'use client'`)
    const sampleLines = sample.split('\n')
    const matched = sampleLines.some((l) => ADMIN_IMPORT_PATTERNS.some((p) => p.test(l)))
    expect(matched).toBe(true)
  })
})
