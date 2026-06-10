/**
 * Sentry server config. Disabled unless a DSN is present (consent-gated /
 * opt-in via env), so local dev and unconfigured previews stay quiet. PII is
 * stripped before any event is sent.
 */
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,

  tracesSampleRate: 0.1,

  environment: process.env.NODE_ENV,

  beforeSend(event) {
    if (event.user) {
      delete event.user.email
      delete event.user.ip_address
      delete event.user.username
    }
    return event
  },
})
