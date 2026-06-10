import { describe, it, expect } from 'vitest'
import { serverEnvSchema, clientEnvSchema } from '@/lib/env'

/**
 * The env schema is the secret-boundary contract (KTD10). The load-bearing
 * behaviour: when CAPTURE_ENABLED=true, the dangerous secrets become required;
 * when it's off, the app boots without them. We exercise the schemas directly
 * against crafted inputs rather than mutating process.env.
 */

const BASE = {
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
}

describe('server env schema', () => {
  it('rejects a missing service-role key', () => {
    const result = serverEnvSchema.safeParse({ CAPTURE_ENABLED: 'false' })
    expect(result.success).toBe(false)
  })

  it('boots without GITHUB_TOKEN / CRON_SECRET when capture is off', () => {
    const result = serverEnvSchema.safeParse({
      ...BASE,
      CAPTURE_ENABLED: 'false',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.CAPTURE_ENABLED).toBe(false)
    }
  })

  it('rejects missing secrets when CAPTURE_ENABLED=true', () => {
    const result = serverEnvSchema.safeParse({
      ...BASE,
      CAPTURE_ENABLED: 'true',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.flatMap((i) => i.path)
      expect(paths).toContain('GITHUB_TOKEN')
      expect(paths).toContain('CRON_SECRET')
    }
  })

  it('rejects a too-short CRON_SECRET when capture is on', () => {
    const result = serverEnvSchema.safeParse({
      ...BASE,
      CAPTURE_ENABLED: 'true',
      GITHUB_TOKEN: 'github_pat_real',
      CRON_SECRET: 'short',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.flatMap((i) => i.path)
      expect(paths).toContain('CRON_SECRET')
      expect(paths).not.toContain('GITHUB_TOKEN')
    }
  })

  it('accepts a fully-configured capture-enabled env', () => {
    const result = serverEnvSchema.safeParse({
      ...BASE,
      CAPTURE_ENABLED: 'true',
      GITHUB_TOKEN: 'github_pat_real',
      CRON_SECRET: 'a-sufficiently-long-cron-secret',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.CAPTURE_ENABLED).toBe(true)
    }
  })

  it("coerces an empty SENTRY_DSN to undefined instead of failing .url()", () => {
    const result = serverEnvSchema.safeParse({
      ...BASE,
      CAPTURE_ENABLED: 'false',
      SENTRY_DSN: '',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.SENTRY_DSN).toBeUndefined()
    }
  })
})

describe('client env schema', () => {
  it('requires a valid Supabase URL + anon key', () => {
    const ok = clientEnvSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    })
    expect(ok.success).toBe(true)

    const bad = clientEnvSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: 'not-a-url',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    })
    expect(bad.success).toBe(false)
  })

  it('never carries a server secret in the public schema', () => {
    // The client schema must not know about server-only keys. Unknown keys are
    // stripped by Zod object parsing, so a service-role key passed in does not
    // survive into the parsed client env.
    const parsed = clientEnvSchema.parse({
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'leaked',
    })
    expect('SUPABASE_SERVICE_ROLE_KEY' in parsed).toBe(false)
  })
})
