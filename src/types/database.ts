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

/**
 * Per-(project, metric) derived-series status (U8). `'ok'` = >= 2 usable points,
 * real velocity/growth; `'tracking_started'` = < 2 points, show the absolute
 * value + a "tracking started" marker, never a false 0% (R12 / KTD6). Mirrors
 * `SeriesStatus` in src/lib/metrics/derive.ts.
 */
export type MetricStatus = 'ok' | 'tracking_started'

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
      /**
       * Anon-facing per-(published project, published cumulative metric) derived
       * numbers (U8 — 00002_derived_views.sql). `security_invoker` view over the
       * gs_published_metric_summaries() definer gate; published-only (KTD10/R21).
       * `status` carries per-(project,metric) degradation (R12); `growth_pct` is
       * null when SUPPRESSED — render `absolute_delta` instead (KTD12). Read-only.
       */
      gs_public_metrics: {
        Row: {
          project_id: string | null
          slug: string | null
          metric: string | null
          status: MetricStatus | null
          latest: number | null
          tracking_started_at: string | null
          velocity_per_day: number | null
          velocity_window_days: number | null
          absolute_delta: number | null
          growth_pct: number | null
        }
        Relationships: []
      }
      /**
       * Anon-facing epoch-aligned cross-project download aggregate curve (U8 —
       * R11/KTD12), published-only. The hero absolute number is SUM(latest) over
       * the `downloads` rows of `gs_public_metrics`; this is the shaped curve over
       * time, aligned to the common capture epoch. Read-only.
       */
      gs_public_aggregate_downloads: {
        Row: {
          day: string | null
          total: number | null
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
      /**
       * SECURITY DEFINER gate behind `gs_public_metrics` (U8). Prefer reading the
       * view; typed here to mirror `gen types`. Published-only (KTD10).
       */
      gs_published_metric_summaries: {
        Args: Record<PropertyKey, never>
        Returns: {
          project_id: string
          slug: string
          metric: string
          status: MetricStatus
          latest: number
          tracking_started_at: string | null
          velocity_per_day: number | null
          velocity_window_days: number
          absolute_delta: number | null
          growth_pct: number | null
        }[]
      }
      /**
       * SECURITY DEFINER wrapper behind `gs_public_aggregate_downloads` (U8).
       * Prefer reading the view; typed here to mirror `gen types`.
       */
      gs_published_aggregate_downloads: {
        Args: Record<PropertyKey, never>
        Returns: {
          day: string
          total: number
        }[]
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
