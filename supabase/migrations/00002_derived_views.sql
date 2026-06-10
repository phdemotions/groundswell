-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: 00002_derived_views
-- Unit: U8 — Derived metrics layer (SQL views over the snapshot store)
-- Plan: docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md
-- Requirements: R10, R11, R12 · KTD1, KTD6, KTD12
-- ═══════════════════════════════════════════════════════════════════════════
--
-- GOAL: turn the raw snapshots/event-logs (00001) into the velocity / growth /
-- aggregate numbers the surfaces read — correct for SPARSE, MIXED-PROVENANCE,
-- LOW-COUNT data. This is the SQL half of U8; src/lib/metrics/derive.ts is the
-- pure-TS half and the two are the SAME contract in two languages. Where the
-- read path is anon-facing it joins onto the published roster
-- (gs_published_projects() / public_showcase) so the trust boundary (KTD10)
-- holds: anon never touches a raw table, only the published projection.
--
-- THE RULES ENCODED HERE (KTD1/KTD6/KTD12), matching derive.ts:
--   1. Per-day download deltas = diff of consecutive CUMULATIVE snapshots; a
--      span_days>1 marker (the sibling 'downloads_span_days' snapshot row from
--      U4) means the delta is a merged multi-day delta — DISTRIBUTED across the
--      spanned days (window function generate_series), never a single-day spike.
--   2. Velocity is SMOOTHED over a trailing window (7-day), not day-over-day.
--   3. Growth % is SUPPRESSED below an absolute-count floor (50) → expose the
--      absolute delta instead; a zero baseline also suppresses (no div-by-zero).
--   4. The cross-project aggregate ALIGNS all series to a common capture epoch
--      so a backfilled star curve doesn't distort the roll-up SHAPE.
--   5. Window uniques are read DIRECTLY from traffic_window — no view here ever
--      sums traffic_daily.uniques (non-additive, KTD1).
--   6. Degradation is per-(project, metric): < 2 points → status
--      'tracking_started' with the absolute value, never a false 0% / error.
--
-- ───────────────────────────────────────────────────────────────────────────
-- RUN ORDER NOTE (GS-001): this migration is applied AFTER 00001 (and after the
-- dedicated Supabase project exists — U0 ops). It is also written test-first:
-- supabase/tests/derived_views.sql encodes the U8 acceptance examples (AE1, AE4,
-- AE5, %-floor, epoch-aligned aggregate, smoothed velocity) against a live DB:
--
--     supabase test db                                  # runs every tests/ file
--     supabase test db supabase/tests/derived_views.sql # just this one
--
-- TRUST BOUNDARY (KTD10), restated for the additions below:
--   • Internal SECURITY DEFINER functions (gs_* with no anon grant) do the
--     heavy math over the raw tables as the privileged owner. They are REVOKEd
--     from PUBLIC/anon/authenticated — only the published wrappers call them.
--   • The ANON-facing surface is a SECURITY DEFINER set-returning function that
--     joins the math to gs_published_projects() (published-only, per-signal
--     visibility) + a thin `security_invoker = on` view over it, mirroring the
--     00001 public_showcase pattern. anon gets EXECUTE/SELECT on those only.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 0. Tunables — kept in ONE immutable function so the SQL + TS defaults agree
-- ───────────────────────────────────────────────────────────────────────────
-- Mirrors src/lib/metrics/derive.ts DEFAULT_CONFIG. If you change one, change
-- both (they are the same contract). IMMUTABLE so the planner can inline them.
CREATE OR REPLACE FUNCTION public.gs_velocity_window_days() RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT 7 $$;
CREATE OR REPLACE FUNCTION public.gs_growth_window_days() RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT 30 $$;
CREATE OR REPLACE FUNCTION public.gs_growth_absolute_floor() RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $$ SELECT 50 $$;

REVOKE EXECUTE ON FUNCTION public.gs_velocity_window_days()  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gs_growth_window_days()    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gs_growth_absolute_floor() FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. gs_cumulative_daily(project_id, metric)
--    Collapse cumulative snapshots → one row per UTC day (last capture wins),
--    carrying the cumulative value and the span_days marker for that day.
-- ═══════════════════════════════════════════════════════════════════════════
-- Internal helper (SECURITY DEFINER, no anon grant). Reads signal_snapshots for
-- one cumulative metric and its sibling '<metric>_span_days' marker rows (U4),
-- collapsing same-day re-captures to the LAST value of the day — the DB-upsert
-- semantics the TS layer also assumes. The span marker is matched on the same
-- captured_at day so a missed-capture gap is attributed to the right delta.
CREATE OR REPLACE FUNCTION public.gs_cumulative_daily(
  p_project_id uuid,
  p_metric     text
)
RETURNS TABLE (
  day        date,
  cumulative numeric,
  span_days  int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH base AS (
    SELECT
      (s.captured_at AT TIME ZONE 'UTC')::date AS day,
      s.value,
      s.captured_at,
      -- last capture of the day wins (same-day re-capture overwrites)
      row_number() OVER (
        PARTITION BY (s.captured_at AT TIME ZONE 'UTC')::date
        ORDER BY s.captured_at DESC
      ) AS rn
    FROM public.signal_snapshots s
    WHERE s.project_id = p_project_id
      AND s.metric = p_metric
      AND s.data_class = 'cumulative'
  ),
  -- The span marker is a sibling snapshot row '<metric>_span_days' written at the
  -- SAME captured_at as the gap delta (U4). Reduce to one value per UTC day.
  spans AS (
    SELECT
      (s.captured_at AT TIME ZONE 'UTC')::date AS day,
      max(s.value)::int AS span_days
    FROM public.signal_snapshots s
    WHERE s.project_id = p_project_id
      AND s.metric = p_metric || '_span_days'
    GROUP BY 1
  )
  SELECT
    b.day,
    greatest(b.value, 0) AS cumulative,   -- clamp >= 0 (counters never go down)
    COALESCE(sp.span_days, 1) AS span_days
  FROM base b
  LEFT JOIN spans sp ON sp.day = b.day
  WHERE b.rn = 1
  ORDER BY b.day;
$$;

COMMENT ON FUNCTION public.gs_cumulative_daily(uuid, text) IS
  'Internal (no anon grant). Collapses cumulative signal_snapshots to one row per UTC day (last capture wins) with the per-day span_days marker (U4). The day-grain input to the delta/velocity/growth math (U8). Mirrors derive.ts collapseToDaily.';

REVOKE EXECUTE ON FUNCTION public.gs_cumulative_daily(uuid, text) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. gs_daily_deltas(project_id, metric)
--    Per-day deltas from the cumulative day series; a span_days>1 day's delta is
--    DISTRIBUTED evenly across the spanned days (KTD1), flagged `merged`.
-- ═══════════════════════════════════════════════════════════════════════════
-- Internal helper. For each consecutive pair of cumulative days, the delta is
-- clamped >= 0. The span is the MAX of the explicit marker and the real calendar
-- gap (a missed marker must not let a multi-day jump read as one day) — matching
-- derive.ts. When span <= 1 the delta lands on the capture day (not merged). When
-- span > 1 the delta is distributed across the `span` days ENDING on the capture
-- day: floor(delta/span) on each, with the integer remainder on the final day so
-- the distributed values SUM to the exact delta. All distributed days are merged.
CREATE OR REPLACE FUNCTION public.gs_daily_deltas(
  p_project_id uuid,
  p_metric     text
)
RETURNS TABLE (
  day    date,
  value  numeric,
  merged boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH daily AS (
    SELECT day, cumulative, span_days
    FROM public.gs_cumulative_daily(p_project_id, p_metric)
  ),
  paired AS (
    SELECT
      day AS curr_day,
      cumulative AS curr_cum,
      lag(cumulative) OVER (ORDER BY day) AS prev_cum,
      lag(day)        OVER (ORDER BY day) AS prev_day,
      span_days
    FROM daily
  ),
  spans AS (
    SELECT
      curr_day,
      greatest(curr_cum - prev_cum, 0) AS raw_delta,
      -- effective span = max(marker, real calendar gap, 1)
      greatest(
        COALESCE(span_days, 1),
        COALESCE((curr_day - prev_day), 1),
        1
      ) AS span
    FROM paired
    WHERE prev_cum IS NOT NULL          -- the first day seeds the baseline only
  )
  -- Distribute each delta across its span days (generate_series 0..span-1 days
  -- back from the capture day). day_offset 0 = the capture day, which also carries
  -- the remainder so the per-day values sum to raw_delta exactly. ("offset" is a
  -- reserved word in Postgres, so the loop column is named day_offset.)
  SELECT
    (s.curr_day - g.day_offset)::date AS day,
    CASE
      WHEN s.span <= 1 THEN s.raw_delta
      WHEN g.day_offset = 0 THEN floor(s.raw_delta / s.span) + (s.raw_delta - floor(s.raw_delta / s.span) * s.span)
      ELSE floor(s.raw_delta / s.span)
    END AS value,
    (s.span > 1) AS merged
  FROM spans s
  CROSS JOIN LATERAL generate_series(0, s.span - 1) AS g(day_offset)
  ORDER BY day;
$$;

COMMENT ON FUNCTION public.gs_daily_deltas(uuid, text) IS
  'Internal (no anon grant). Per-day deltas from cumulative snapshots; a span_days>1 gap delta is distributed evenly across the spanned days (KTD1) and flagged merged, so smoothing never reads a missed-capture gap as a single-day spike. Mirrors derive.ts deltasFromCumulative.';

REVOKE EXECUTE ON FUNCTION public.gs_daily_deltas(uuid, text) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. gs_metric_summary(project_id, metric)
--    The per-(project, metric) derived numbers WITH degradation (R12/KTD6):
--    smoothed velocity, floor-suppressed growth %, absolute delta, status.
-- ═══════════════════════════════════════════════════════════════════════════
-- Internal helper. Returns exactly one row. With < 2 captured days the series is
-- degraded: status 'tracking_started', the absolute latest + the tracking_started
-- anchor, and velocity/growth/delta all NULL — never a false 0%, never an error
-- (AE1). With >= 2 days: status 'ok' with real numbers; growth_pct is NULL when
-- the baseline is below the absolute floor or zero (KTD12 — show absolute_delta).
CREATE OR REPLACE FUNCTION public.gs_metric_summary(
  p_project_id uuid,
  p_metric     text
)
RETURNS TABLE (
  status               text,
  latest               numeric,
  tracking_started_at  date,
  velocity_per_day     numeric,
  velocity_window_days int,
  absolute_delta       numeric,
  growth_pct           numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_vel_window  int     := public.gs_velocity_window_days();
  v_grw_window  int     := public.gs_growth_window_days();
  v_floor       numeric := public.gs_growth_absolute_floor();

  v_count       int;
  v_latest      numeric;
  v_latest_day  date;
  v_first_day   date;

  v_velocity    numeric;
  v_baseline    numeric;
  v_cutoff      date;
  v_abs_delta   numeric;
  v_growth_pct  numeric;
BEGIN
  -- Day-grain shape scalars for this (project, metric). The function is STABLE,
  -- so we read gs_cumulative_daily via set-returning subqueries (no temp table —
  -- CREATE TABLE AS would force VOLATILE and break under concurrent reads).
  SELECT count(*), max(day), min(day)
  INTO v_count, v_latest_day, v_first_day
  FROM public.gs_cumulative_daily(p_project_id, p_metric);

  -- No points at all → degraded, zero latest, null anchor.
  IF v_count = 0 THEN
    RETURN QUERY SELECT 'tracking_started'::text, 0::numeric, NULL::date,
                        NULL::numeric, v_vel_window, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  SELECT cumulative INTO v_latest
  FROM public.gs_cumulative_daily(p_project_id, p_metric)
  WHERE day = v_latest_day;

  -- < 2 points → degrade to absolute + tracking_started (R12 / AE1). No 0%.
  IF v_count < 2 THEN
    RETURN QUERY SELECT 'tracking_started'::text, v_latest, v_first_day,
                        NULL::numeric, v_vel_window, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- ── Smoothed velocity: sum of per-day deltas in the trailing window / window
  --    length (KTD6). Dividing by the FIXED window length makes it a true rate
  --    (quiet days genuinely count as 0).
  SELECT COALESCE(sum(value), 0) / v_vel_window
  INTO v_velocity
  FROM public.gs_daily_deltas(p_project_id, p_metric)
  WHERE day > (v_latest_day - v_vel_window)   -- (latest - window + 1) .. latest
    AND day <= v_latest_day;

  -- ── Growth over the trailing window. Baseline = cumulative at-or-before the
  --    cutoff (else the earliest point for a young series).
  v_cutoff := v_latest_day - v_grw_window;
  SELECT cumulative INTO v_baseline
  FROM public.gs_cumulative_daily(p_project_id, p_metric)
  WHERE day <= v_cutoff
  ORDER BY day DESC
  LIMIT 1;

  IF v_baseline IS NULL THEN
    SELECT cumulative INTO v_baseline
    FROM public.gs_cumulative_daily(p_project_id, p_metric)
    WHERE day = v_first_day;
  END IF;

  v_abs_delta := v_latest - v_baseline;

  -- Suppress % below the floor or on a zero baseline (KTD12) → show abs delta.
  IF v_baseline < v_floor OR v_baseline = 0 THEN
    v_growth_pct := NULL;
  ELSE
    v_growth_pct := v_abs_delta / v_baseline;
  END IF;

  RETURN QUERY SELECT 'ok'::text, v_latest, v_first_day,
                      v_velocity, v_vel_window, v_abs_delta, v_growth_pct;
END;
$$;

COMMENT ON FUNCTION public.gs_metric_summary(uuid, text) IS
  'Internal (no anon grant). Per-(project,metric) derived numbers with graceful degradation (R12/KTD6): smoothed velocity, floor-suppressed growth % (KTD12), absolute delta, and a status of ok | tracking_started. Mirrors derive.ts deriveCumulativeMetric.';

REVOKE EXECUTE ON FUNCTION public.gs_metric_summary(uuid, text) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. gs_window_uniques(repo, metric)
--    Authoritative window-level uniques, read DIRECTLY from traffic_window —
--    NEVER summed from traffic_daily (KTD1 / AE5).
-- ═══════════════════════════════════════════════════════════════════════════
-- Internal helper. Returns the MOST RECENT captured window's own uniques + count
-- for one (repo, metric). There is deliberately NO function here that sums
-- traffic_daily.uniques (uniques are non-additive). This is the only correct
-- source for "uniques over the window" the surfaces show.
CREATE OR REPLACE FUNCTION public.gs_window_uniques(
  p_repo   text,
  p_metric text
)
RETURNS TABLE (
  uniques      integer,
  count        integer,
  window_start date,
  window_end   date
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    greatest(w.uniques, 0) AS uniques,
    greatest(w.count, 0)   AS count,
    w.window_start,
    w.window_end
  FROM public.traffic_window w
  WHERE w.repo = p_repo
    AND w.metric = p_metric
  ORDER BY w.window_end DESC, w.window_start DESC, w.captured_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.gs_window_uniques(text, text) IS
  'Internal (no anon grant). The authoritative window-level uniques for a (repo, metric), read DIRECTLY from the most recent traffic_window row — never summed from traffic_daily (uniques are non-additive, KTD1/AE5). Mirrors derive.ts windowUniques.';

REVOKE EXECUTE ON FUNCTION public.gs_window_uniques(text, text) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. gs_event_curve(repo, kind)
--    Backfillable cumulative curve from an EVENT log (stars / forks) — a true
--    historical curve with no capture-date floor (R8 / AE4).
-- ═══════════════════════════════════════════════════════════════════════════
-- Internal helper. Builds the running-count curve from native event timestamps
-- (stars.starred_at / forks.created_at). One row per day with >= 1 event,
-- carrying the running total. NO diffing, NO capture-date floor — a fresh repo
-- shows its full backfilled star curve immediately while its download velocity
-- is still 'tracking_started' (AE4).
CREATE OR REPLACE FUNCTION public.gs_event_curve(
  p_repo text,
  p_kind text   -- 'stars' | 'forks'
)
RETURNS TABLE (
  day        date,
  cumulative bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH events AS (
    SELECT (starred_at AT TIME ZONE 'UTC')::date AS day
    FROM public.stars
    WHERE p_kind = 'stars' AND repo = p_repo
    UNION ALL
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day
    FROM public.forks
    WHERE p_kind = 'forks' AND repo = p_repo
  ),
  per_day AS (
    SELECT day, count(*) AS n FROM events GROUP BY day
  )
  SELECT
    day,
    sum(n) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative
  FROM per_day
  ORDER BY day;
$$;

COMMENT ON FUNCTION public.gs_event_curve(text, text) IS
  'Internal (no anon grant). Backfillable cumulative curve (R8) from the stars/forks event logs by native event date — no capture-date floor, so a fresh repo shows its full star history while downloads are still tracking_started (AE4). Mirrors derive.ts eventCumulativeCurve.';

REVOKE EXECUTE ON FUNCTION public.gs_event_curve(text, text) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. gs_aggregate_downloads_epoch()
--    Cross-project download roll-up, ALIGNED to a common capture epoch (KTD12),
--    over PUBLISHED projects only. The epoch is the latest per-project first day.
-- ═══════════════════════════════════════════════════════════════════════════
-- Internal helper. The aggregate curve's SHAPE must not be distorted by a series
-- that starts far earlier than the others (KTD12). The epoch is the LATEST of
-- every contributing series' FIRST captured day — the first day we hold a real
-- value for EVERY series. For each day epoch..max, each project contributes its
-- most-recent cumulative at-or-before that day (forward-filled within its own
-- range). Scoped to PUBLISHED projects that publish the 'downloads' signal — the
-- aggregate is part of the anon hero, so it must respect visibility (KTD10/R21).
-- Pure SQL (no temp table — STABLE). CTEs build the per-project published
-- download day-curves, derive the epoch (max of per-project first-days) and the
-- last day, generate the day spine epoch..last, and for each day sum every
-- project's most-recent cumulative at-or-before that day (forward-fill).
CREATE OR REPLACE FUNCTION public.gs_aggregate_downloads_epoch()
RETURNS TABLE (
  day   date,
  total numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH proj_daily AS (
    -- Per-project download day-curves, PUBLISHED 'downloads' only. We reuse the
    -- published roster gate so visibility is enforced in one place (KTD10).
    SELECT p.id AS project_id, d.day, d.cumulative
    FROM public.gs_published_projects() p
    CROSS JOIN LATERAL public.gs_cumulative_daily(p.id, 'downloads') d
    WHERE (p.visibility ->> 'downloads')::boolean IS TRUE
  ),
  bounds AS (
    -- Epoch = max of per-project first-days; last = max of per-project last-days.
    SELECT max(first_day) AS epoch, max(last_day) AS last_day
    FROM (
      SELECT project_id, min(day) AS first_day, max(day) AS last_day
      FROM proj_daily
      GROUP BY project_id
    ) f
  ),
  -- Day spine epoch..last (empty when there are no published download series →
  -- the whole result is empty and the caller shows the absolute hero).
  days AS (
    SELECT generate_series(b.epoch, b.last_day, interval '1 day')::date AS day
    FROM bounds b
    WHERE b.epoch IS NOT NULL
  )
  SELECT
    dd.day,
    COALESCE(SUM(asof.cumulative), 0) AS total
  FROM days dd
  -- For each (day, project), the most-recent cumulative at-or-before the day.
  LEFT JOIN LATERAL (
    SELECT pj.project_id, pj.cumulative
    FROM proj_daily pj
    WHERE pj.day <= dd.day
      AND pj.day = (
        SELECT max(pj2.day) FROM proj_daily pj2
        WHERE pj2.project_id = pj.project_id AND pj2.day <= dd.day
      )
  ) asof ON TRUE
  GROUP BY dd.day
  ORDER BY dd.day;
$$;

COMMENT ON FUNCTION public.gs_aggregate_downloads_epoch() IS
  'Internal (no anon grant — called by the published wrapper). Cross-project download roll-up over PUBLISHED downloads, aligned to a common capture epoch (KTD12) so a backfilled/early series does not distort the aggregate shape. Mirrors derive.ts aggregateEpochAligned.';

REVOKE EXECUTE ON FUNCTION public.gs_aggregate_downloads_epoch() FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. ANON-FACING SURFACE — published-only derived showcase
-- ═══════════════════════════════════════════════════════════════════════════
-- Mirrors the 00001 public_showcase pattern: a SECURITY DEFINER function that
-- joins the per-metric math to gs_published_projects() (published-only,
-- per-signal visibility), exposed through a thin `security_invoker = on` view.
-- This is the ONLY place the derived numbers cross to anon, and it surfaces a
-- metric only when that project publishes that signal (KTD10/R21). The absolute
-- 'latest' is the honest hero contribution (KTD12); growth_pct is NULL when
-- suppressed; status carries the per-(project,metric) degradation (R12).
--
-- v1 surfaces the cumulative-counter signals the showcase leads with: downloads,
-- stars-count, watchers (each a 'cumulative' snapshot metric). Backfilled curves
-- (stars/forks over time) and window uniques are exposed via the dedicated
-- functions above; the consuming surface (U10) composes them per the mockup.
CREATE OR REPLACE FUNCTION public.gs_published_metric_summaries()
RETURNS TABLE (
  project_id           uuid,
  slug                 text,
  metric               text,
  status               text,
  latest               numeric,
  tracking_started_at  date,
  velocity_per_day     numeric,
  velocity_window_days int,
  absolute_delta       numeric,
  growth_pct           numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    p.id AS project_id,
    p.slug,
    m.metric,
    s.status,
    s.latest,
    s.tracking_started_at,
    s.velocity_per_day,
    s.velocity_window_days,
    s.absolute_delta,
    s.growth_pct
  FROM public.gs_published_projects() p
  -- Only the cumulative-counter metrics the public showcase leads with. Each is
  -- gated on its own per-signal visibility flag, so a project that publishes
  -- downloads but not watchers surfaces only downloads.
  CROSS JOIN LATERAL (
    VALUES ('downloads'), ('stars'), ('watchers')
  ) AS m(metric)
  CROSS JOIN LATERAL public.gs_metric_summary(p.id, m.metric) s
  WHERE (p.visibility ->> m.metric)::boolean IS TRUE;
$$;

COMMENT ON FUNCTION public.gs_published_metric_summaries() IS
  'Anon-facing derived surface: per-(published project, published cumulative metric) summary joined onto gs_published_projects() so visibility (KTD10/R21) is enforced. Each metric appears only when that project publishes that signal. Exposed via the gs_public_metrics view.';

-- Lock down, then grant EXECUTE to anon (+ authenticated for the radar later).
REVOKE EXECUTE ON FUNCTION public.gs_published_metric_summaries() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.gs_published_metric_summaries() TO anon, authenticated;

-- The view: thin, security_invoker so it adds no privileges of its own; all
-- gating lives in the definer function (mirrors public_showcase). SOLE anon read
-- path for derived numbers.
CREATE OR REPLACE VIEW public.gs_public_metrics
WITH (security_invoker = on) AS
  SELECT
    project_id,
    slug,
    metric,
    status,
    latest,
    tracking_started_at,
    velocity_per_day,
    velocity_window_days,
    absolute_delta,
    growth_pct
  FROM public.gs_published_metric_summaries();

COMMENT ON VIEW public.gs_public_metrics IS
  'Anon-facing per-(published project, published metric) derived numbers (U8). security_invoker over the gs_published_metric_summaries() definer gate; published-only (KTD10/R21). status carries per-metric degradation (R12); growth_pct NULL = suppressed, show absolute_delta (KTD12).';

REVOKE ALL    ON public.gs_public_metrics FROM PUBLIC;
GRANT  SELECT ON public.gs_public_metrics TO anon, authenticated;

-- The published, epoch-aligned aggregate download curve as an anon view (the
-- shaped curve behind the hero; the absolute hero NUMBER is just SUM(latest)
-- over the downloads rows of gs_public_metrics, which needs no alignment).
CREATE OR REPLACE FUNCTION public.gs_published_aggregate_downloads()
RETURNS TABLE (day date, total numeric)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT day, total FROM public.gs_aggregate_downloads_epoch();
$$;

COMMENT ON FUNCTION public.gs_published_aggregate_downloads() IS
  'Anon-facing wrapper over gs_aggregate_downloads_epoch() (published-only, epoch-aligned, KTD12). Exposed via gs_public_aggregate_downloads.';

REVOKE EXECUTE ON FUNCTION public.gs_published_aggregate_downloads() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.gs_published_aggregate_downloads() TO anon, authenticated;

CREATE OR REPLACE VIEW public.gs_public_aggregate_downloads
WITH (security_invoker = on) AS
  SELECT day, total FROM public.gs_published_aggregate_downloads();

COMMENT ON VIEW public.gs_public_aggregate_downloads IS
  'Anon-facing epoch-aligned cross-project download aggregate curve (R11/KTD12), published-only. The hero absolute number is SUM(latest) over downloads in gs_public_metrics; this is the shaped curve over time.';

REVOKE ALL    ON public.gs_public_aggregate_downloads FROM PUBLIC;
GRANT  SELECT ON public.gs_public_aggregate_downloads TO anon, authenticated;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-MIGRATION FOLLOW-UPS (tracked in supabase/README.md + STATUS/ISSUES)
-- ═══════════════════════════════════════════════════════════════════════════
-- • GS-001 (U0 ops): apply AFTER 00001 against the live dedicated Supabase
--   project, then run supabase/tests/derived_views.sql (`supabase test db`).
-- • Regenerate src/types/database.ts from the live DB so the new views/functions
--   (gs_public_metrics, gs_public_aggregate_downloads, gs_published_* fns) are
--   typed from introspection rather than the hand-authored additions in 00002.
-- • PERF (post-data, not a v1 blocker): the per-metric functions recompute on
--   every read. With the v1 tracked-repo count this is trivial, but once the
--   snapshot store grows, consider a MATERIALIZED VIEW refreshed by the capture
--   cron (or pg_cron) for gs_public_metrics / the aggregate curve. The function
--   contract stays identical — only the storage changes (swap behind the view).
-- • The aggregate currently rolls up downloads (the hero). A stars-count
--   aggregate is the same shape (swap the metric); add when U10 needs it.
-- ═══════════════════════════════════════════════════════════════════════════
