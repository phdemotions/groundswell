-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: 00001_snapshot_model
-- Unit: U2 — Snapshot schema + RLS + public-showcase view
-- Plan: docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md
-- Requirements: R1, R3, R5, R9, R20, R21 · KTD1, KTD2, KTD10, KTD11
-- ═══════════════════════════════════════════════════════════════════════════
--
-- GOAL: a source-agnostic snapshot store with a HARD anon/owner trust boundary
-- and correct uniques handling.
--
-- Trust boundary (KTD10), summarised:
--   • RLS is ENABLED on every base table, and every base table is DENY-ALL for
--     anon — there is no anon SELECT/INSERT/UPDATE/DELETE policy AND the table
--     privileges are REVOKEd from anon. (RLS-enabled-with-no-policy already
--     denies; the REVOKE is belt-and-suspenders so a future stray policy can't
--     silently open a table.)
--   • Writes are SERVICE-ROLE ONLY. The service role bypasses RLS, so it needs
--     no policy. The capture path (src/lib/supabase/admin.ts, server-only) is
--     the only routine writer.
--   • The SOLE anon read path is the `public_showcase` view (security_invoker),
--     which returns only rows whose per-signal `projects.visibility` flag is
--     published. A direct `projects` SELECT by anon must NOT leak the
--     unpublished repo roster or the visibility flags — hence DENY-ALL on
--     `projects` too (belt-and-suspenders behind the view).
--
-- Conventions (mirrors fourposts + claritas):
--   • public schema only (KTD11 — own dedicated Supabase project).
--   • created_at / updated_at on the curated `projects` table, with an
--     updated_at trigger. Snapshot/append tables are immutable event rows and
--     carry only their capture timestamps.
--   • Soft delete via deleted_at on `projects`; the view excludes deleted rows.
--   • RLS + policies + grants live in THIS migration (never split out).
--   • Idempotent where practical (IF NOT EXISTS / DROP … IF EXISTS).
--
-- Source-agnostic model (KTD2): `signal_snapshots` is the generic
-- (project, source, metric, value, data_class, captured_at) spine — new
-- sources/metrics add ROWS, not schema. The traffic_* / stars / forks tables
-- are GitHub-shaped landing tables for the perishable 14-day window and the
-- backfill event logs (KTD1); v1 wires GitHub only and builds no source
-- adapters/registries.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 0. Shared updated_at trigger function
-- ───────────────────────────────────────────────────────────────────────────
-- Auto-invoked by Postgres on row events; clients never call it directly, so
-- EXECUTE is revoked from PUBLIC/anon/authenticated (fourposts OPU-338 pattern —
-- avoids exposing it as an RPC-callable function on the anon API surface).
CREATE OR REPLACE FUNCTION public.gs_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.gs_set_updated_at() FROM PUBLIC, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. projects — curated tracked list, per-signal visibility, soft delete
-- ───────────────────────────────────────────────────────────────────────────
-- `owner` is the GitHub account/org login (e.g. "phdemotions"); `repo` is the
-- repo name; together they form the canonical "owner/repo" GitHub slug that the
-- traffic_* / stars / forks tables key on via their own `repo` text column
-- (stored as the full "owner/repo" slug — see those tables).
--
-- `visibility` is a JSONB map of per-signal publish flags (R21): capture is
-- broad, publishing is selective and PER SIGNAL. The `public_showcase` view
-- reads these flags to decide what anon may see. Example:
--   {"downloads": true, "stars": true, "forks": false, "views": false,
--    "clones": false, "referrers": false, "ship_cadence": true,
--    "watchers": false}
-- A missing key is treated as NOT published (the view uses a safe default).
CREATE TABLE IF NOT EXISTS public.projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- GitHub identity
  owner         text NOT NULL,
  repo          text NOT NULL,

  -- public-facing identity
  slug          text NOT NULL,                 -- URL slug for the showcase route
  display_name  text NOT NULL,                 -- human title on the card
  tagline       text,                          -- one-line description
  homepage_url  text,                          -- optional canonical project link

  -- curation + visibility (R20, R21)
  is_tracked    boolean NOT NULL DEFAULT true, -- capture eligibility (R20)
  visibility    jsonb   NOT NULL DEFAULT '{}'::jsonb, -- per-signal publish flags

  -- lifecycle
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,                   -- soft delete (NULL = active)

  CONSTRAINT projects_owner_repo_key UNIQUE (owner, repo),
  CONSTRAINT projects_slug_key       UNIQUE (slug),
  CONSTRAINT projects_visibility_is_object CHECK (jsonb_typeof(visibility) = 'object')
);

COMMENT ON TABLE  public.projects IS 'Curated tracked-project list. Anon DENY-ALL — the unpublished repo roster and per-signal visibility flags must never leak; anon reads only the public_showcase view (KTD10).';
COMMENT ON COLUMN public.projects.visibility IS 'JSONB per-signal publish flags, e.g. {"downloads":true,"stars":true,"views":false}. Missing key = not published. Drives the public_showcase view (R21).';
COMMENT ON COLUMN public.projects.is_tracked IS 'Capture eligibility (R20). Independent of visibility (R21): capture broadly, publish selectively.';
COMMENT ON COLUMN public.projects.deleted_at IS 'Soft delete. NULL = active; non-NULL excluded from default reads + the public_showcase view.';

CREATE INDEX IF NOT EXISTS projects_tracked_active_idx
  ON public.projects (is_tracked)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS projects_set_updated_at ON public.projects;
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.gs_set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. signal_snapshots — source-agnostic snapshot spine (KTD2)
-- ───────────────────────────────────────────────────────────────────────────
-- Immutable event rows. Each capture writes one row per (project, source,
-- metric). `data_class` (R5) tells the derived layer how to treat the value:
--   cumulative     — monotonic running total, no native history (e.g. downloads,
--                    stars-count, watchers); per-day deltas are DIFFED.
--   timeseries     — native point-in-time series the source provides directly.
--   rolling_window — owner-only perishable window (e.g. the 14-day traffic
--                    window aggregate); see traffic_* tables for the day grain.
CREATE TABLE IF NOT EXISTS public.signal_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  source      text NOT NULL DEFAULT 'github',  -- 'github' in v1; model is source-agnostic (R9)
  metric      text NOT NULL,                   -- 'downloads' | 'stars' | 'forks' | 'watchers' | …
  value       numeric NOT NULL,
  data_class  text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT signal_snapshots_data_class_check
    CHECK (data_class IN ('cumulative', 'timeseries', 'rolling_window'))
);

COMMENT ON TABLE  public.signal_snapshots IS 'Source-agnostic snapshot spine (KTD2): one immutable row per (project, source, metric) per capture. New sources/metrics add rows, not schema (R3, R9). Anon DENY-ALL.';
COMMENT ON COLUMN public.signal_snapshots.data_class IS 'Data-availability class (R5): cumulative | timeseries | rolling_window. Tells the derived layer how to treat the value (diff cumulative, never sum window uniques).';

CREATE INDEX IF NOT EXISTS signal_snapshots_project_metric_time_idx
  ON public.signal_snapshots (project_id, metric, captured_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. traffic_daily — perishable 14-day views/clones window, DAY grain (KTD1)
-- ───────────────────────────────────────────────────────────────────────────
-- `repo` is the full "owner/repo" GitHub slug. UNIQUE (repo, metric, day)
-- powers the 14-day self-healing re-upsert: each run pulls the full window and
-- upserts ON CONFLICT (repo, metric, day) DO UPDATE — a re-run the same day
-- overwrites, never duplicates (R4, KTD1).
-- `uniques` here is the PER-DAY unique count from GitHub; it is NON-ADDITIVE —
-- the derived layer must NEVER sum daily uniques into a window/monthly figure.
-- Window-level uniques live in traffic_window (below), captured separately.
CREATE TABLE IF NOT EXISTS public.traffic_daily (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo        text NOT NULL,                   -- "owner/repo" slug
  metric      text NOT NULL,                   -- 'views' | 'clones'
  day         date NOT NULL,
  count       integer NOT NULL DEFAULT 0,      -- total events that day
  uniques     integer NOT NULL DEFAULT 0,      -- per-day uniques (NON-ADDITIVE)
  captured_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT traffic_daily_repo_metric_day_key UNIQUE (repo, metric, day),
  CONSTRAINT traffic_daily_count_nonneg   CHECK (count >= 0),
  CONSTRAINT traffic_daily_uniques_nonneg CHECK (uniques >= 0),
  CONSTRAINT traffic_daily_metric_check   CHECK (metric IN ('views', 'clones'))
);

COMMENT ON TABLE  public.traffic_daily IS 'Perishable 14-day traffic window at DAY grain (KTD1). UNIQUE (repo, metric, day) drives the self-healing ON CONFLICT DO UPDATE re-upsert (R4). Anon DENY-ALL.';
COMMENT ON COLUMN public.traffic_daily.uniques IS 'PER-DAY unique count. NON-ADDITIVE — never sum these into a window/monthly total; use traffic_window for window-level uniques (KTD1).';

CREATE INDEX IF NOT EXISTS traffic_daily_repo_metric_day_idx
  ON public.traffic_daily (repo, metric, day DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. traffic_window — window-level totals, uniques persisted SEPARATELY (KTD1)
-- ───────────────────────────────────────────────────────────────────────────
-- GitHub returns a window-level `uniques` total alongside the per-day series.
-- Because uniques are non-additive, that window total is the ONLY correct
-- source for "uniques over the window" — it is stored here, distinct from the
-- daily rows, and the derived layer uses it DIRECTLY (never summed from
-- traffic_daily). One row per (repo, metric, window) per capture.
CREATE TABLE IF NOT EXISTS public.traffic_window (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo         text NOT NULL,                  -- "owner/repo" slug
  metric       text NOT NULL,                  -- 'views' | 'clones'
  window_start date NOT NULL,
  window_end   date NOT NULL,
  count        integer NOT NULL DEFAULT 0,     -- window-level total events
  uniques      integer NOT NULL DEFAULT 0,     -- window-level uniques (authoritative)
  captured_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT traffic_window_count_nonneg   CHECK (count >= 0),
  CONSTRAINT traffic_window_uniques_nonneg CHECK (uniques >= 0),
  CONSTRAINT traffic_window_metric_check   CHECK (metric IN ('views', 'clones')),
  CONSTRAINT traffic_window_range_check    CHECK (window_end >= window_start)
);

COMMENT ON TABLE  public.traffic_window IS 'Window-level traffic totals captured separately from the daily grain (KTD1). uniques here are authoritative for the window — the derived layer uses them DIRECTLY and never sums traffic_daily.uniques. Anon DENY-ALL.';
COMMENT ON COLUMN public.traffic_window.uniques IS 'Window-level unique count from GitHub. Authoritative; never derive window uniques by summing daily rows (uniques are non-additive, KTD1).';

CREATE INDEX IF NOT EXISTS traffic_window_repo_metric_captured_idx
  ON public.traffic_window (repo, metric, captured_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. traffic_referrers — perishable referrer sources, keyed (repo, referrer, day)
-- ───────────────────────────────────────────────────────────────────────────
-- Referrers have no per-day axis from GitHub (it returns a current snapshot of
-- top referrers); we stamp each capture with `day` and upsert keyed
-- (repo, referrer, day) so a same-day re-run overwrites (KTD1).
CREATE TABLE IF NOT EXISTS public.traffic_referrers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo        text NOT NULL,                   -- "owner/repo" slug
  referrer    text NOT NULL,                   -- e.g. "github.com", "Google"
  day         date NOT NULL,
  count       integer NOT NULL DEFAULT 0,
  uniques     integer NOT NULL DEFAULT 0,
  captured_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT traffic_referrers_repo_referrer_day_key UNIQUE (repo, referrer, day),
  CONSTRAINT traffic_referrers_count_nonneg   CHECK (count >= 0),
  CONSTRAINT traffic_referrers_uniques_nonneg CHECK (uniques >= 0)
);

COMMENT ON TABLE  public.traffic_referrers IS 'Perishable referrer snapshot keyed (repo, referrer, day) for same-day re-upsert (KTD1). Anon DENY-ALL.';

CREATE INDEX IF NOT EXISTS traffic_referrers_repo_day_idx
  ON public.traffic_referrers (repo, day DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. stars — backfillable stargazer event log (R8)
-- ───────────────────────────────────────────────────────────────────────────
-- One row per (repo, github_user) with the timestamped `starred_at` (parsed
-- from the GitHub stargazers `star+json` media type). Backfill reconstructs the
-- full star curve; steady-state capture appends new stargazers. Idempotent via
-- UNIQUE (repo, github_user).
CREATE TABLE IF NOT EXISTS public.stars (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo        text NOT NULL,                   -- "owner/repo" slug
  github_user text NOT NULL,                   -- stargazer login
  starred_at  timestamptz NOT NULL,            -- from star+json media type
  captured_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stars_repo_user_key UNIQUE (repo, github_user)
);

COMMENT ON TABLE public.stars IS 'Backfillable stargazer event log (R8): one row per (repo, github_user) with starred_at. UNIQUE (repo, github_user) makes append/backfill idempotent. Anon DENY-ALL.';

CREATE INDEX IF NOT EXISTS stars_repo_starred_at_idx
  ON public.stars (repo, starred_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 7. forks — backfillable fork event log (R8)
-- ───────────────────────────────────────────────────────────────────────────
-- One row per fork (`fork_id` is the GitHub repo id of the fork) with its
-- `created_at`. Idempotent via UNIQUE (repo, fork_id).
CREATE TABLE IF NOT EXISTS public.forks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo        text NOT NULL,                   -- "owner/repo" slug (the SOURCE repo)
  fork_id     bigint NOT NULL,                 -- GitHub repo id of the fork
  created_at  timestamptz NOT NULL,            -- fork creation timestamp from GitHub
  captured_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT forks_repo_fork_key UNIQUE (repo, fork_id)
);

COMMENT ON TABLE  public.forks IS 'Backfillable fork event log (R8): one row per fork. UNIQUE (repo, fork_id) makes append/backfill idempotent. Anon DENY-ALL.';
COMMENT ON COLUMN public.forks.created_at IS 'Fork creation timestamp from the GitHub API (the per-fork event time), NOT this row''s insert time. See captured_at for ingest time.';

CREATE INDEX IF NOT EXISTS forks_repo_created_at_idx
  ON public.forks (repo, created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 8. capture_runs — capture telemetry + watchdog anchor
-- ───────────────────────────────────────────────────────────────────────────
-- One row per capture run. `last_successful_capture_at` is the watchdog anchor
-- (KTD3, U4): advanced ONLY on an all-ok run; the independent pg_cron watchdog
-- (00003) alerts when it falls >10 days stale. Anon DENY-ALL — capture
-- telemetry (and any error strings) must never be public.
CREATE TABLE IF NOT EXISTS public.capture_runs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  finished_at                timestamptz,
  status                     text NOT NULL DEFAULT 'running',
  last_successful_capture_at timestamptz,      -- watchdog anchor (advance only on all-ok)
  error                      text,             -- failure detail (never public)

  CONSTRAINT capture_runs_status_check
    CHECK (status IN ('running', 'success', 'partial', 'error'))
);

COMMENT ON TABLE  public.capture_runs IS 'Capture-run telemetry + watchdog anchor (KTD3). Anon DENY-ALL — run status and error strings are never public.';
COMMENT ON COLUMN public.capture_runs.last_successful_capture_at IS 'Watchdog anchor: advance ONLY when a run is all-ok (a partial-failure run must not reset the clock). The pg_cron watchdog (00003) alerts at >10 days stale.';

CREATE INDEX IF NOT EXISTS capture_runs_started_at_idx
  ON public.capture_runs (started_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY — DENY-ALL for anon on EVERY base table (KTD10)
-- ═══════════════════════════════════════════════════════════════════════════
-- RLS is ENABLED on every table and NO anon policy is created → anon is denied
-- by default. We ALSO REVOKE table privileges from anon (and authenticated) as
-- a second, independent guard: even if a future migration accidentally adds a
-- permissive policy, the missing GRANT still blocks anon. Writes are
-- service-role only (the service role bypasses RLS and needs no policy).
--
-- authenticated is revoked too in this unit: the private radar + curation
-- (U11) will add scoped authenticated policies + grants in a LATER migration.
-- Until then nothing but the service role touches these tables, and the public
-- showcase reads exclusively through the public_showcase view (granted below).

ALTER TABLE public.projects          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.traffic_daily     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.traffic_window    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.traffic_referrers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stars             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_runs      ENABLE ROW LEVEL SECURITY;

-- Force RLS so the table OWNER is also subject to it (the service role connects
-- as a BYPASSRLS role, so capture still works; this only closes the owner hole).
ALTER TABLE public.projects          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.signal_snapshots  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.traffic_daily     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.traffic_window    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.traffic_referrers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stars             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.forks             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.capture_runs      FORCE ROW LEVEL SECURITY;

-- Belt-and-suspenders: strip all table privileges from the client roles. No
-- anon/authenticated policy exists either, so these tables are unreachable by
-- any client. (No GRANT to anon/authenticated anywhere in this migration.)
REVOKE ALL ON public.projects          FROM anon, authenticated;
REVOKE ALL ON public.signal_snapshots  FROM anon, authenticated;
REVOKE ALL ON public.traffic_daily     FROM anon, authenticated;
REVOKE ALL ON public.traffic_window    FROM anon, authenticated;
REVOKE ALL ON public.traffic_referrers FROM anon, authenticated;
REVOKE ALL ON public.stars             FROM anon, authenticated;
REVOKE ALL ON public.forks             FROM anon, authenticated;
REVOKE ALL ON public.capture_runs      FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- public_showcase — the SOLE anon read path (published-visibility rows only)
-- ═══════════════════════════════════════════════════════════════════════════
-- The trust boundary creates a deliberate tension: anon must SELECT the
-- PUBLISHED subset, yet `projects` is DENY-ALL for anon (a direct
-- `SELECT FROM projects` must leak nothing — not the unpublished roster, not the
-- visibility flags). A pure `security_invoker` view would inherit anon's RLS and
-- therefore return ZERO rows. So the visibility filter is encapsulated in ONE
-- SECURITY DEFINER set-returning function — the single auditable gate — and the
-- view is a thin `security_invoker = on` wrapper over it:
--
--   • gs_published_projects()  SECURITY DEFINER, search_path-pinned. Runs the
--     published-only / non-deleted / tracked filter as the (privileged) owner,
--     so it CAN read `projects`. Returns only the curated columns and only the
--     published per-signal flags. EXECUTE granted to anon; nothing else.
--   • public_showcase          A `security_invoker = on` view over the function.
--     security_invoker keeps the VIEW itself from adding any privileges of its
--     own (best practice, and it can never become an escalation hole); all
--     gating lives in the definer function. SELECT granted to anon.
--
-- Net effect: anon reads exactly the published projection and nothing else;
-- every base table — including `projects` — stays deny-all. The function is the
-- only place visibility is decided, so the boundary is auditable in one spot.
-- ───────────────────────────────────────────────────────────────────────────

-- Published-only projection, encapsulated in a SECURITY DEFINER function so the
-- visibility filter is the single, auditable gate. The function exposes ONLY
-- published, non-deleted projects and ONLY the signals whose per-signal
-- visibility flag is true. It returns NO raw snapshot values here — U8's
-- derived views (00002) join onto this published roster to compute the numbers
-- anon may see. This keeps the anon surface to "which projects + which signals
-- are published," never the raw capture tables.
CREATE OR REPLACE FUNCTION public.gs_published_projects()
RETURNS TABLE (
  id           uuid,
  owner        text,
  repo         text,
  slug         text,
  display_name text,
  tagline      text,
  homepage_url text,
  visibility   jsonb,
  created_at   timestamptz,
  updated_at   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    p.id,
    p.owner,
    p.repo,
    p.slug,
    p.display_name,
    p.tagline,
    p.homepage_url,
    -- Project only the published per-signal flags into the public surface, so
    -- anon never learns which signals are *deliberately hidden* (the absence of
    -- a key is indistinguishable from "not published"). We keep only keys whose
    -- value is exactly boolean true.
    COALESCE(
      (
        SELECT jsonb_object_agg(kv.key, to_jsonb(true))
        FROM jsonb_each(p.visibility) AS kv(key, val)
        WHERE kv.val = to_jsonb(true)
      ),
      '{}'::jsonb
    ) AS visibility,
    p.created_at,
    p.updated_at
  FROM public.projects p
  WHERE p.deleted_at IS NULL
    -- A project appears publicly only if it is tracked AND at least one signal
    -- is published (no empty published cards leak the unpublished roster).
    AND p.is_tracked = true
    AND EXISTS (
      SELECT 1
      FROM jsonb_each(p.visibility) AS kv(key, val)
      WHERE kv.val = to_jsonb(true)
    );
$$;

COMMENT ON FUNCTION public.gs_published_projects() IS 'SECURITY DEFINER gate for the anon-facing published projection. Returns only non-deleted, tracked projects that publish at least one signal, and projects only the published per-signal flags. The single auditable visibility filter behind public_showcase (KTD10, R21).';

-- Lock the definer function down: only anon (+ authenticated, for the radar's
-- own use later) may execute it. Revoke the broad default first.
REVOKE EXECUTE ON FUNCTION public.gs_published_projects() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.gs_published_projects() TO anon, authenticated;

-- The view is a thin, stable name over the definer function. security_invoker
-- is on so the view adds no privileges of its own; all gating lives in the
-- function. This is the SOLE anon read path.
CREATE OR REPLACE VIEW public.public_showcase
WITH (security_invoker = on) AS
  SELECT
    id,
    owner,
    repo,
    slug,
    display_name,
    tagline,
    homepage_url,
    visibility,
    created_at,
    updated_at
  FROM public.gs_published_projects();

COMMENT ON VIEW public.public_showcase IS 'The SOLE anon read path (KTD10). Returns only published-visibility, non-deleted, tracked projects via the gs_published_projects() definer gate. Anon has SELECT here and DENY-ALL on every base table.';

-- anon (and authenticated) may read the published projection and nothing else.
REVOKE ALL    ON public.public_showcase FROM PUBLIC;
GRANT  SELECT ON public.public_showcase TO anon, authenticated;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-MIGRATION FOLLOW-UPS (tracked in supabase/README.md + STATUS/ISSUES)
-- ═══════════════════════════════════════════════════════════════════════════
-- • GS-001 (U0 ops): provision the dedicated Supabase project, then apply this
--   migration and run supabase/tests/rls_snapshot_model.sql (`supabase test db`).
-- • Post-U0: regenerate src/types/database.ts from the live DB
--   (`supabase gen types typescript`) to replace the hand-authored types.
-- • U8 (00002_derived_views.sql): derived read views join onto
--   gs_published_projects() / public_showcase to expose the published numbers.
-- • U11 (curation + auth): add scoped `authenticated` RLS policies + grants for
--   the owner on projects (+ read access to the raw tables as needed).
-- ═══════════════════════════════════════════════════════════════════════════
