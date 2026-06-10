/**
 * Hand-authored Supabase schema type for Groundswell.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY HAND-AUTHORED (and the follow-up to regenerate):
 *   `supabase gen types typescript` needs a live database to introspect, and the
 *   dedicated Supabase project is not provisioned yet (GS-001 / U0 ops). This
 *   file is therefore authored BY HAND to mirror the shape `gen types` produces
 *   (per-table Row/Insert/Update, Views, Functions), so it is a drop-in match.
 *
 *   POST-GS-001 FOLLOW-UP: once U0 provisions the DB and 00001_snapshot_model.sql
 *   is applied, REGENERATE this file from the live schema and delete this notice:
 *
 *     supabase gen types typescript --linked > src/types/database.ts
 *     # or: supabase gen types typescript --project-id <ref> > src/types/database.ts
 *
 *   Keep this file and supabase/migrations/00001_snapshot_model.sql in lockstep
 *   until then — they are the same contract expressed in two languages.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Schema: `public` (KTD11 — own dedicated Supabase project, no custom schema).
 * Source of truth: supabase/migrations/00001_snapshot_model.sql.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

/** Data-availability class for a signal snapshot (R5). */
export type DataClass = 'cumulative' | 'timeseries' | 'rolling_window'

/** Status of a capture run (KTD3). */
export type CaptureRunStatus = 'running' | 'success' | 'partial' | 'error'

/** Traffic metrics with a day/window grain (KTD1). */
export type TrafficMetric = 'views' | 'clones'

/**
 * Per-signal publish flags stored in `projects.visibility` (R21). A missing key
 * is treated as NOT published. The public_showcase view exposes only the keys
 * whose value is exactly `true`. Keys are signal names, intentionally open
 * (source-agnostic, KTD2) — common v1 GitHub signals enumerated for ergonomics.
 */
export type SignalVisibility = {
  downloads?: boolean
  stars?: boolean
  forks?: boolean
  watchers?: boolean
  views?: boolean
  clones?: boolean
  referrers?: boolean
  ship_cadence?: boolean
} & { [signal: string]: boolean | undefined }

export interface Database {
  public: {
    Tables: {
      projects: {
        Row: {
          id: string
          owner: string
          repo: string
          slug: string
          display_name: string
          tagline: string | null
          homepage_url: string | null
          is_tracked: boolean
          visibility: SignalVisibility
          created_at: string
          updated_at: string
          deleted_at: string | null
        }
        Insert: {
          id?: string
          owner: string
          repo: string
          slug: string
          display_name: string
          tagline?: string | null
          homepage_url?: string | null
          is_tracked?: boolean
          visibility?: SignalVisibility
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
        }
        Update: {
          id?: string
          owner?: string
          repo?: string
          slug?: string
          display_name?: string
          tagline?: string | null
          homepage_url?: string | null
          is_tracked?: boolean
          visibility?: SignalVisibility
          created_at?: string
          updated_at?: string
          deleted_at?: string | null
        }
        Relationships: []
      }
      signal_snapshots: {
        Row: {
          id: string
          project_id: string
          source: string
          metric: string
          value: number
          data_class: DataClass
          captured_at: string
        }
        Insert: {
          id?: string
          project_id: string
          source?: string
          metric: string
          value: number
          data_class: DataClass
          captured_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          source?: string
          metric?: string
          value?: number
          data_class?: DataClass
          captured_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'signal_snapshots_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects'
            referencedColumns: ['id']
          },
        ]
      }
      traffic_daily: {
        Row: {
          id: string
          repo: string
          metric: TrafficMetric
          day: string
          count: number
          uniques: number
          captured_at: string
        }
        Insert: {
          id?: string
          repo: string
          metric: TrafficMetric
          day: string
          count?: number
          uniques?: number
          captured_at?: string
        }
        Update: {
          id?: string
          repo?: string
          metric?: TrafficMetric
          day?: string
          count?: number
          uniques?: number
          captured_at?: string
        }
        Relationships: []
      }
      traffic_window: {
        Row: {
          id: string
          repo: string
          metric: TrafficMetric
          window_start: string
          window_end: string
          count: number
          uniques: number
          captured_at: string
        }
        Insert: {
          id?: string
          repo: string
          metric: TrafficMetric
          window_start: string
          window_end: string
          count?: number
          uniques?: number
          captured_at?: string
        }
        Update: {
          id?: string
          repo?: string
          metric?: TrafficMetric
          window_start?: string
          window_end?: string
          count?: number
          uniques?: number
          captured_at?: string
        }
        Relationships: []
      }
      traffic_referrers: {
        Row: {
          id: string
          repo: string
          referrer: string
          day: string
          count: number
          uniques: number
          captured_at: string
        }
        Insert: {
          id?: string
          repo: string
          referrer: string
          day: string
          count?: number
          uniques?: number
          captured_at?: string
        }
        Update: {
          id?: string
          repo?: string
          referrer?: string
          day?: string
          count?: number
          uniques?: number
          captured_at?: string
        }
        Relationships: []
      }
      stars: {
        Row: {
          id: string
          repo: string
          github_user: string
          starred_at: string
          captured_at: string
        }
        Insert: {
          id?: string
          repo: string
          github_user: string
          starred_at: string
          captured_at?: string
        }
        Update: {
          id?: string
          repo?: string
          github_user?: string
          starred_at?: string
          captured_at?: string
        }
        Relationships: []
      }
      forks: {
        Row: {
          id: string
          repo: string
          fork_id: number
          created_at: string
          captured_at: string
        }
        Insert: {
          id?: string
          repo: string
          fork_id: number
          created_at: string
          captured_at?: string
        }
        Update: {
          id?: string
          repo?: string
          fork_id?: number
          created_at?: string
          captured_at?: string
        }
        Relationships: []
      }
      capture_runs: {
        Row: {
          id: string
          started_at: string
          finished_at: string | null
          status: CaptureRunStatus
          last_successful_capture_at: string | null
          error: string | null
        }
        Insert: {
          id?: string
          started_at?: string
          finished_at?: string | null
          status?: CaptureRunStatus
          last_successful_capture_at?: string | null
          error?: string | null
        }
        Update: {
          id?: string
          started_at?: string
          finished_at?: string | null
          status?: CaptureRunStatus
          last_successful_capture_at?: string | null
          error?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      /**
       * The SOLE anon read path (KTD10). Returns only published-visibility,
       * non-deleted, tracked projects via the gs_published_projects() definer
       * gate; `visibility` carries only the published (true) per-signal flags.
       * Read-only — a view has no Insert/Update.
       */
      public_showcase: {
        Row: {
          id: string | null
          owner: string | null
          repo: string | null
          slug: string | null
          display_name: string | null
          tagline: string | null
          homepage_url: string | null
          visibility: SignalVisibility | null
          created_at: string | null
          updated_at: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      /**
       * SECURITY DEFINER gate behind public_showcase. Not called directly from
       * app code (read the view instead); typed here to mirror `gen types`.
       */
      gs_published_projects: {
        Args: Record<PropertyKey, never>
        Returns: {
          id: string
          owner: string
          repo: string
          slug: string
          display_name: string
          tagline: string | null
          homepage_url: string | null
          visibility: SignalVisibility
          created_at: string
          updated_at: string
        }[]
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
