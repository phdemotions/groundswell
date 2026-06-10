import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Authenticated surfaces (private radar + curation). The public showcase is
// unauthenticated and intentionally absent here. Expand in U11 when the auth UI
// and the (app) route group land.
const PROTECTED_PREFIXES = ['/app', '/radar', '/projects']

/**
 * Session-refresh + route-gate helper invoked by the Next 16 `proxy.ts` entry.
 *
 * On Next 16 the request-interception entry is `proxy.ts` exporting `proxy()`;
 * a file named `middleware.ts` is ignored, so the auth gate would silently not
 * run. This helper lives under src/lib/supabase/ (not at the root) and is
 * imported by the root proxy.ts.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set({ name, value, ...options })
          })
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set({ name, value, ...options })
          })
        },
      },
    }
  )

  // getUser() validates the JWT server-side (enterprise pattern). getSession()
  // trusts the client cookie and can be spoofed — never gate on it.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname

  if (!user && PROTECTED_PREFIXES.some((p) => path.startsWith(p))) {
    const loginUrl = new URL('/login', request.url)
    const returnPath = request.nextUrl.pathname + request.nextUrl.search
    loginUrl.searchParams.set('redirect_url', returnPath)
    return NextResponse.redirect(loginUrl)
  }

  // MUST return the response object to pass refreshed cookies to the browser.
  return response
}
