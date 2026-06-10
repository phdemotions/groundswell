/**
 * Sentry browser config. Disabled unless NEXT_PUBLIC_SENTRY_DSN is present.
 * Session replay is off by default (privacy); only error sessions are sampled.
 * PII is stripped from events and breadcrumbs.
 */
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: 0.1,

  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0.5,

  environment: process.env.NODE_ENV,

  beforeSend(event) {
    if (event.user) {
      delete event.user.email
      delete event.user.ip_address
      delete event.user.username
    }
    return event
  },

  beforeBreadcrumb(breadcrumb) {
    if (breadcrumb.category === 'xhr' || breadcrumb.category === 'fetch') {
      if (breadcrumb.data?.url?.includes('supabase')) {
        delete breadcrumb.data.response_body_size
      }
    }
    return breadcrumb
  },
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
