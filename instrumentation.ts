/**
 * Next.js instrumentation hook — wires Sentry for the server and edge runtimes.
 * No-ops when the DSN is absent (the configs gate on it).
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.server.config')
  }
}

export const onRequestError = Sentry.captureRequestError
