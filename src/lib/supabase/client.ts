'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database'

/**
 * Browser Supabase client (anon key, cookie-based). RLS applies — this client
 * can only ever read what the anon role is allowed to see (the published-only
 * showcase view; raw tables are deny-all for anon per KTD10).
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
