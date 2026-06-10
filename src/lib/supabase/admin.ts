// `server-only` makes this module fail the build if it is ever pulled into a
// client bundle. The service-role key bypasses RLS entirely and must never
// reach the browser. This is the runtime half of the guard; the lint rule
// (eslint.config.mjs) and the import-barrier test are the static halves.
import 'server-only'

import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

let _admin: ReturnType<typeof createClient<Database>> | null = null

/**
 * Service-role Supabase client (RLS bypass). Use ONLY for the capture path
 * (writes to raw tables) and other authorized server-side operations. Lazily
 * constructed so importing this module never crashes when the key is absent in
 * a context that doesn't actually call it.
 */
export function getAdmin() {
  if (!_admin) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!url || !key) {
      throw new Error(
        'getAdmin(): Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
      )
    }

    _admin = createClient<Database>(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return _admin
}
