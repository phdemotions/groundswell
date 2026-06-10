-- ═══════════════════════════════════════════════════════════════════════════
-- pgTAP: derived-metrics assertions for U8
-- Migrations under test:
--   supabase/migrations/00001_snapshot_model.sql  (tables + public_showcase)
--   supabase/migrations/00002_derived_views.sql   (derived functions + views)
-- Plan: docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md (U8)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- RUN ORDER NOTE (GS-001): these are DB-LEVEL assertions of the derived-metrics
-- contract — the SQL twin of src/lib/metrics/derive.test.ts. They prove the
-- actual Postgres window-function math (delta distribution, smoothed velocity,
-- floor-suppressed growth, epoch-aligned aggregate) AND the trust boundary
-- (anon reads the published derived views only, never the internal functions or
-- raw tables). They REQUIRE a live database with 00001 + 00002 applied and the
-- Supabase anon/authenticated/service_role roles present. The dedicated Supabase
-- project is not provisioned until U0 ops (GS-001), so this runs AFTER GS-001:
--
--     supabase test db                                  # all files
--     supabase test db supabase/tests/derived_views.sql # just this one
--
-- Written test-first: the assertions encode the U8 acceptance examples and
-- double as its DB-level acceptance gate.
--
-- WHAT THIS COVERS (the U8 test scenarios — 16 assertions):
--   Per-(project,metric) degradation (R12 / AE1):
--     1.  A single download snapshot → status 'tracking_started', latest = value.
--     2.  …and growth_pct IS NULL (no false 0%), velocity_per_day IS NULL.
--     3.  …and tracking_started_at = the single snapshot's day.
--   Per-day deltas + span-marker distribution (KTD1):
--     4.  Consecutive cumulative snapshots diff into per-day deltas (not merged).
--     5.  A span_days>1 gap delta is DISTRIBUTED across the spanned days …
--     6.  …flagged merged, and the distributed values SUM to the exact delta.
--   Smoothed velocity (KTD6):
--     7.  A 0/1/3 spike train resolves to a stable trailing-window rate (≈ sum/7).
--   Growth %-floor suppression (KTD12):
--     8.  Baseline below the floor → growth_pct NULL, absolute_delta shown.
--     9.  Baseline at/above the floor → a real growth_pct.
--   Window uniques (AE5 / KTD1):
--     10. gs_window_uniques returns the window-level total, NOT the daily sum.
--   Backfilled event curve while downloads start at capture date (AE4):
--     11. gs_event_curve('stars') starts at the OLDEST star (no capture floor) …
--     12. …while the same repo's downloads summary is 'tracking_started'.
--   Epoch-aligned aggregate (R11 / KTD12):
--     13. The published aggregate curve STARTS at the common epoch (latest first
--         day), not the earlier series' first day.
--     14. The aggregate total on the epoch day = SUM of per-project values.
--   Trust boundary (KTD10):
--     15. anon CAN SELECT the published derived view (gs_public_metrics).
--     16. anon CANNOT EXECUTE an internal function (gs_metric_summary) — 42501.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT plan(16);

-- ───────────────────────────────────────────────────────────────────────────
-- Seed (runs as the test superuser → bypasses RLS, mirrors service-role writes).
-- All fixtures are transaction-local and rolled back at the end.
-- ───────────────────────────────────────────────────────────────────────────

-- Project A — published downloads + stars. Rich download series for velocity /
-- growth, a span-gap, and a backfilled star curve.
INSERT INTO public.projects (id, owner, repo, slug, display_name, is_tracked, visibility)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'phdemotions', 'citegeist', 'citegeist', 'Citegeist',
  true,
  '{"downloads": true, "stars": true}'::jsonb
);

-- Project B — published downloads, tracked LATER than A (for the epoch test).
INSERT INTO public.projects (id, owner, repo, slug, display_name, is_tracked, visibility)
VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'phdemotions', 'provenance', 'provenance', 'Provenance',
  true,
  '{"downloads": true}'::jsonb
);

-- Project C — single download snapshot only (degradation / AE1). Deliberately
-- UNPUBLISHED (no published signal) so it is the pure "fresh, not-yet-published"
-- case: the degradation assertions call gs_metric_summary directly (internal,
-- not visibility-gated), while C is correctly ABSENT from the published-only
-- aggregate and gs_public_metrics — keeping the epoch test isolated to A + B.
INSERT INTO public.projects (id, owner, repo, slug, display_name, is_tracked, visibility)
VALUES (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'phdemotions', 'fresh', 'fresh', 'Fresh Repo',
  true,
  '{}'::jsonb
);

-- ── Project C: a SINGLE download snapshot (AE1). ──────────────────────────────
INSERT INTO public.signal_snapshots (project_id, source, metric, value, data_class, captured_at)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'github', 'downloads', 200, 'cumulative',
        TIMESTAMPTZ '2026-06-10T12:00:00Z');

-- ── Project A downloads: a 0/1/3 spike train + a span-marked gap. ─────────────
-- Days 06-01..06-08 cumulative (deltas 0,1,0,3,0,1,0), then a 4-day GAP to 06-12
-- with a span marker of 4 (delta +20 distributed across 06-09..06-12).
INSERT INTO public.signal_snapshots (project_id, source, metric, value, data_class, captured_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads',   0, 'cumulative', TIMESTAMPTZ '2026-06-01T12:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads',   0, 'cumulative', TIMESTAMPTZ '2026-06-02T12:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads',   1, 'cumulative', TIMESTAMPTZ '2026-06-03T12:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads',   1, 'cumulative', TIMESTAMPTZ '2026-06-04T12:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads',   4, 'cumulative', TIMESTAMPTZ '2026-06-05T12:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads',   4, 'cumulative', TIMESTAMPTZ '2026-06-06T12:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads',   5, 'cumulative', TIMESTAMPTZ '2026-06-07T12:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads',   5, 'cumulative', TIMESTAMPTZ '2026-06-08T12:00:00Z'),
  -- 4-day gap → next capture on 06-12 with span marker 4; cumulative jumps +20.
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads',  25, 'cumulative', TIMESTAMPTZ '2026-06-12T12:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'downloads_span_days', 4, 'cumulative', TIMESTAMPTZ '2026-06-12T12:00:00Z');

-- ── A separate growth fixture on Project A's 'stars' COUNT metric ─────────────
-- (cumulative snapshots; distinct from the stars EVENT log). Baseline 100 on
-- 05-10, latest 118 on 06-09 → 30-day window → +18 / +18%. Above the floor (50).
INSERT INTO public.signal_snapshots (project_id, source, metric, value, data_class, captured_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'stars', 100, 'cumulative', TIMESTAMPTZ '2026-05-10T12:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'github', 'stars', 118, 'cumulative', TIMESTAMPTZ '2026-06-09T12:00:00Z');

-- ── Project A stars EVENT log: backfilled curve from native timestamps (AE4). ─
INSERT INTO public.stars (repo, github_user, starred_at) VALUES
  ('phdemotions/citegeist', 'alice', TIMESTAMPTZ '2023-02-01T00:00:00Z'),
  ('phdemotions/citegeist', 'bob',   TIMESTAMPTZ '2023-08-15T00:00:00Z'),
  ('phdemotions/citegeist', 'carol', TIMESTAMPTZ '2024-05-20T00:00:00Z'),
  ('phdemotions/citegeist', 'dave',  TIMESTAMPTZ '2026-06-10T00:00:00Z');

-- ── Window uniques (AE5): authoritative window total 120, distinct from any
-- daily sum. Seed daily rows that would sum HIGHER to prove we don't sum them. ─
INSERT INTO public.traffic_window (repo, metric, window_start, window_end, count, uniques)
VALUES ('phdemotions/citegeist', 'views', DATE '2026-05-30', DATE '2026-06-12', 700, 120);

INSERT INTO public.traffic_daily (repo, metric, day, count, uniques) VALUES
  ('phdemotions/citegeist', 'views', DATE '2026-06-10', 50, 40),
  ('phdemotions/citegeist', 'views', DATE '2026-06-11', 60, 45),
  ('phdemotions/citegeist', 'views', DATE '2026-06-12', 70, 50);
-- (daily uniques sum = 135 > the authoritative window 120 — never summed.)

-- ── Epoch fixture: A downloads start 06-01; B downloads start LATER (06-10). ──
INSERT INTO public.signal_snapshots (project_id, source, metric, value, data_class, captured_at) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'github', 'downloads', 5,  'cumulative', TIMESTAMPTZ '2026-06-10T12:00:00Z'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'github', 'downloads', 9,  'cumulative', TIMESTAMPTZ '2026-06-12T12:00:00Z');

-- ═══════════════════════════════════════════════════════════════════════════
-- 1–3. Degradation: a single snapshot → tracking_started, no false 0% (AE1)
-- ═══════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT status FROM public.gs_metric_summary('cccccccc-cccc-cccc-cccc-cccccccccccc', 'downloads')),
  'tracking_started',
  'AE1: a single download snapshot degrades to status tracking_started'
);

SELECT ok(
  (SELECT growth_pct FROM public.gs_metric_summary('cccccccc-cccc-cccc-cccc-cccccccccccc', 'downloads')) IS NULL
  AND
  (SELECT velocity_per_day FROM public.gs_metric_summary('cccccccc-cccc-cccc-cccc-cccccccccccc', 'downloads')) IS NULL,
  'AE1: a single snapshot yields NULL growth_pct and NULL velocity (no false 0%)'
);

SELECT is(
  (SELECT tracking_started_at FROM public.gs_metric_summary('cccccccc-cccc-cccc-cccc-cccccccccccc', 'downloads')),
  DATE '2026-06-10',
  'AE1: tracking_started_at is the single snapshot day; latest is the absolute value'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4–6. Per-day deltas + span-marker distribution (KTD1)
-- ═══════════════════════════════════════════════════════════════════════════

-- 4. The consecutive 06-03 delta is +1 and NOT merged (a normal day).
SELECT is(
  (SELECT value FROM public.gs_daily_deltas('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'downloads')
    WHERE day = DATE '2026-06-03'),
  1::numeric,
  'consecutive cumulative snapshots diff into per-day deltas (06-03 = +1, not merged)'
);

-- 5. The span-gap distributes the +20 across 06-09..06-12 (4 days) → all merged.
SELECT is(
  (SELECT count(*)::int FROM public.gs_daily_deltas('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'downloads')
    WHERE day BETWEEN DATE '2026-06-09' AND DATE '2026-06-12' AND merged IS TRUE),
  4,
  'a span_days>1 gap delta is distributed across all 4 spanned days, flagged merged'
);

-- 6. The distributed values SUM to the exact delta (+20): 5+5+5+5.
SELECT is(
  (SELECT sum(value) FROM public.gs_daily_deltas('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'downloads')
    WHERE day BETWEEN DATE '2026-06-09' AND DATE '2026-06-12'),
  20::numeric,
  'the distributed merged-gap deltas sum to the exact +20 delta (no value lost/created)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Smoothed velocity — stable on the 0/1/3 spike train (KTD6)
-- ═══════════════════════════════════════════════════════════════════════════
-- Velocity is sum(trailing-7-day deltas)/7. The latest day is 06-12; the
-- trailing window 06-06..06-12 covers deltas: 06-07 (+1), and the distributed
-- gap 06-09..06-12 (5 each = 20) → sum 21 → 21/7 = 3.0. A raw day-over-day read
-- would have shown a 20 spike on 06-12; smoothing yields a calm 3.0.
SELECT ok(
  abs(
    (SELECT velocity_per_day FROM public.gs_metric_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'downloads'))
    - 3.0
  ) < 0.0001,
  'smoothed velocity over the trailing 7-day window is a stable rate (≈3.0), not a 20 spike'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 8–9. Growth %-floor suppression (KTD12)
-- ═══════════════════════════════════════════════════════════════════════════

-- 8. Project A 'downloads': baseline at the 30-day cutoff is small (< floor 50),
--    so growth_pct is suppressed and the absolute delta is surfaced instead.
SELECT ok(
  (SELECT growth_pct FROM public.gs_metric_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'downloads')) IS NULL
  AND
  (SELECT absolute_delta FROM public.gs_metric_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'downloads')) IS NOT NULL,
  'growth_pct is SUPPRESSED below the absolute-count floor; absolute_delta is shown (KTD12)'
);

-- 9. Project A 'stars' COUNT: baseline 100 (>= floor 50) → real +18% growth.
SELECT ok(
  abs(
    (SELECT growth_pct FROM public.gs_metric_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'stars'))
    - 0.18
  ) < 0.0001,
  'growth_pct is a real percentage (+18%) when the baseline is at/above the floor'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Window uniques use the window total, NEVER the daily sum (AE5 / KTD1)
-- ═══════════════════════════════════════════════════════════════════════════
-- The authoritative window uniques is 120; the daily uniques sum is 135. The
-- function returns 120 — proving it reads traffic_window directly, never sums.
SELECT is(
  (SELECT uniques FROM public.gs_window_uniques('phdemotions/citegeist', 'views')),
  120,
  'AE5: window uniques is the authoritative window total (120), never the daily sum (135)'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 11–12. Backfilled event curve while downloads start at capture date (AE4)
-- ═══════════════════════════════════════════════════════════════════════════

-- 11. The star EVENT curve starts at the OLDEST star (2023-02-01) — no floor.
SELECT is(
  (SELECT min(day) FROM public.gs_event_curve('phdemotions/citegeist', 'stars')),
  DATE '2023-02-01',
  'AE4: the backfilled star curve starts at the oldest star event (no capture-date floor)'
);

-- 12. …while the same project's DOWNLOAD series tracking_started is 2026-06-01 —
--     a fresh download metric can coexist with a years-deep star curve (per metric).
SELECT ok(
  (SELECT tracking_started_at FROM public.gs_metric_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'downloads'))
    > (SELECT min(day) FROM public.gs_event_curve('phdemotions/citegeist', 'stars')),
  'AE4: downloads start (2026) after the backfilled star curve (2023) — per-metric provenance'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 13–14. Epoch-aligned aggregate (R11 / KTD12)
-- ═══════════════════════════════════════════════════════════════════════════
-- A downloads start 06-01, B start 06-10. The epoch is the LATER first day
-- (06-10). The aggregate curve must START at 06-10, not 06-01 (which would draw
-- a misleading A-only ramp before B exists).
SELECT is(
  (SELECT min(day) FROM public.gs_aggregate_downloads_epoch()),
  DATE '2026-06-10',
  'the published aggregate starts at the common epoch (06-10), not the earlier series first day'
);

-- 14. On the epoch day (06-10): A's cumulative as-of 06-10 is 5 (last ≤ 06-10:
--     the 06-08 value of 5), B's is 5 → total 10. (C is unpublished, so its 200
--     is correctly EXCLUDED from the published-only aggregate — KTD10/R21.)
SELECT is(
  (SELECT total FROM public.gs_aggregate_downloads_epoch() WHERE day = DATE '2026-06-10'),
  10::numeric,
  'the aggregate total on the epoch day = sum of each project cumulative as-of that day'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 15–16. Trust boundary (KTD10): anon reads the published view, not internals
-- ═══════════════════════════════════════════════════════════════════════════
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" TO '{"role":"anon"}';

-- 15. anon CAN read the published derived view (the sole anon derived path). It
--     returns the published metrics; Project A publishes downloads + stars.
SELECT ok(
  (SELECT count(*) FROM public.gs_public_metrics) > 0,
  'anon CAN SELECT the published derived view gs_public_metrics (sole anon derived path)'
);

-- 16. anon CANNOT call an internal function — it has no EXECUTE grant → 42501.
SELECT throws_ok(
  $$SELECT public.gs_metric_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'downloads')$$,
  '42501',
  NULL,
  'anon CANNOT EXECUTE the internal gs_metric_summary (no grant — math stays behind the gate)'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
