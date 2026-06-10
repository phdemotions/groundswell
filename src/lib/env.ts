import { z } from 'zod'

/**
 * Validated environment surface.
 *
 * Two schemas, never crossed:
 *   - `client` holds only NEXT_PUBLIC_* values (safe to ship to the browser).
 *   - `server` holds secrets that must never leave the server (service-role key,
 *     GitHub PAT, cron secret). None of these carry a NEXT_PUBLIC_ prefix.
 *
 * Capture is OFF by default (KTD10). The dangerous secrets (GITHUB_TOKEN,
 * CRON_SECRET) are only *required* when CAPTURE_ENABLED is true — so local dev
 * and an unconfigured preview boot cleanly, but a deploy that turns capture on
 * cannot start without a real token and a sufficiently-long cron secret.
 */

// A weak/short CRON_SECRET defeats the timingSafeEqual gate on the capture
// route; require real entropy when capture is live.
const MIN_CRON_SECRET_LENGTH = 16

const captureFlag = z
  .string()
  .optional()
  .transform((v) => v === 'true')

const baseServer = z.object({
  // Service-role key — server-only, bypasses RLS. Always required so the admin
  // client never silently builds with an empty key.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  CAPTURE_ENABLED: captureFlag,
  // Conditionally required (see superRefine below).
  GITHUB_TOKEN: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  // Sentry DSN — optional. Empty string ('') is coerced to undefined so a blank
  // Vercel/local value takes the disabled path instead of failing .url().
  SENTRY_DSN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional()
  ),
})

const server = baseServer.superRefine((val, ctx) => {
  if (!val.CAPTURE_ENABLED) return

  if (!val.GITHUB_TOKEN || val.GITHUB_TOKEN.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GITHUB_TOKEN'],
      message:
        'GITHUB_TOKEN must be a non-empty fine-grained PAT when CAPTURE_ENABLED=true.',
    })
  }

  if (!val.CRON_SECRET || val.CRON_SECRET.length < MIN_CRON_SECRET_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CRON_SECRET'],
      message: `CRON_SECRET must be at least ${MIN_CRON_SECRET_LENGTH} characters when CAPTURE_ENABLED=true.`,
    })
  }
})

const client = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url()
    .optional()
    .default('http://localhost:3000'),
  NEXT_PUBLIC_SENTRY_DSN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional()
  ),
})

/**
 * Parse a raw env record against both schemas. Exported (rather than only the
 * eager singleton below) so tests can assert the schema's behaviour against
 * crafted inputs without mutating `process.env`.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env) {
  return {
    ...server.parse(source),
    ...client.parse(source),
  }
}

export { server as serverEnvSchema, client as clientEnvSchema }

export const env = parseEnv()
