import { updateSession } from '@/lib/supabase/middleware'
import type { NextRequest } from 'next/server'

/**
 * Next 16 request-interception entry. On Next 16 this MUST be `proxy.ts`
 * exporting `proxy()` — a file named `middleware.ts` is silently ignored, which
 * would disable the auth gate. See KTD10.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
