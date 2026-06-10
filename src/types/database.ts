/**
 * Placeholder Supabase schema type.
 *
 * U2 (snapshot schema + RLS migration) replaces this with the generated type
 * (`supabase gen types typescript`). Until then this minimal shape lets the
 * typed Supabase clients compile under strict mode without `any`.
 */
export interface Database {
  public: {
    Tables: Record<string, never>
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
