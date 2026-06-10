import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'

/**
 * Server Supabase client (anon key, cookie-based) for Server Components, Server
 * Actions, and Route Handlers. RLS applies. For RLS-bypassing service-role
 * access, use the server-only-guarded admin client (./admin.ts) instead.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component — safe to ignore when the proxy
            // (proxy.ts) is refreshing sessions on every request.
          }
        },
      },
    }
  )
}
