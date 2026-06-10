-- ═══════════════════════════════════════════════════════════════════════════
-- pgTAP: capture idempotency + watchdog assertions for U4
-- Migrations under test:
--   supabase/migrations/00001_snapshot_model.sql  (tables + constraints)
--   supabase/migrations/00003_watchdog.sql        (gs_capture_watchdog + pg_cron)
-- Plan: docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md (U4)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- RUN ORDER NOTE (GS-001): these are DB-LEVEL invariants that CANNOT be covered
-- by the route's mock-based unit tests — they prove the actual Postgres
-- ON CONFLICT semantics, the constraint behaviour over a simulated multi-day
-- capture gap, and the watchdog function's staleness decision. They REQUIRE a
-- live database with both migrations applied (and, for the watchdog, the pg_cron
-- + pg_net extensions). The dedicated Supabase project is not provisioned until
-- U0 ops (GS-001), so this runs AFTER GS-001, alongside the U2 RLS suite:
--
--     supabase test db                                       # all files
--     supabase test db supabase/tests/capture_idempotency.sql   # just this one
--
-- Written test-first: the assertions encode the capture contract U4 must satisfy
-- and double as its DB-level acceptance gate.
--
-- WHAT THIS COVERS (the U4 idempotency + watchdog scenarios — 13 assertions):
--   Idempotent re-run (same day):
--     1.  A same-(repo,metric,day) re-upsert does NOT create a duplicate row.
--     2.  The re-upsert OVERWRITES count + uniques (last write wins).
--     3.  Referrers re-upsert (repo,referrer,day) does not duplicate.
--   14-day self-healing window after a gap:
--     4.  Upserting a full 14-day window inserts 14 distinct days.
--     5.  A 5-day-later run re-upserting the overlapping window keeps ONE row
--         per day (no duplication) and backfills the 5 new days → still ≤ the
--         distinct-day count, never corrupted.
--     6.  Window-level uniques are stored in traffic_window, DISTINCT from the
--         sum of the daily uniques (non-additive, KTD1).
--   Backfill append idempotency:
--     7.  Re-appending the same stargazer is a no-op (UNIQUE repo,github_user).
--     8.  Re-appending the same fork is a no-op (UNIQUE repo,fork_id).
--   Watchdog staleness decision (gs_capture_watchdog):
--     9.  The function + the pg_cron schedule exist.
--     10. With NO capture runs, the watchdog is idle (no throw, no alert).
--     11. With a FRESH success (< 10 days), the watchdog does not alert (no throw).
--     12. With a STALE success (> 10 days) and no Vault endpoint, it warns and
--         returns cleanly (no throw) — the alert path is reached without pg_net.
--     13. last_successful_capture_at is the watchdog anchor: a 'partial' run with
--         a NULL anchor does NOT count as a successful capture.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT plan(13);

-- ───────────────────────────────────────────────────────────────────────────
-- Seed a project (runs as the test superuser → bypasses RLS, mirrors the
-- service-role capture writes). All fixtures are transaction-local.
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO public.projects (id, owner, repo, slug, display_name, is_tracked, visibility)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'phdemotions', 'citegeist', 'citegeist', 'Citegeist',
  true,
  '{"stars": true, "downloads": true}'::jsonb
);

-- ───────────────────────────────────────────────────────────────────────────
-- 1–3. Idempotent same-day re-run (the route's upsert contract, R4 / KTD1)
-- ───────────────────────────────────────────────────────────────────────────

-- First capture of a single day.
INSERT INTO public.traffic_daily (repo, metric, day, count, uniques)
VALUES ('phdemotions/citegeist', 'views', DATE '2026-06-10', 10, 5);

-- Re-run the SAME day with new counts via ON CONFLICT (what the route does).
INSERT INTO public.traffic_daily (repo, metric, day, count, uniques)
VALUES ('phdemotions/citegeist', 'views', DATE '2026-06-10', 17, 9)
ON CONFLICT (repo, metric, day)
DO UPDATE SET count = EXCLUDED.count, uniques = EXCLUDED.uniques;

-- 1. Still exactly one row for that (repo, metric, day) — no duplication.
SELECT is(
  (SELECT count(*)::int FROM public.traffic_daily
    WHERE repo = 'phdemotions/citegeist' AND metric = 'views'
      AND day = DATE '2026-06-10'),
  1,
  'same-day re-upsert keeps exactly one (repo, metric, day) row (no duplicate)'
);

-- 2. The counts were OVERWRITTEN by the re-run (last write wins, self-healing).
SELECT is(
  (SELECT count FROM public.traffic_daily
    WHERE repo = 'phdemotions/citegeist' AND metric = 'views'
      AND day = DATE '2026-06-10'),
  17,
  'same-day re-upsert overwrites count (corrected value wins)'
);

-- 3. Referrers re-upsert on the same (repo, referrer, day) does not duplicate.
INSERT INTO public.traffic_referrers (repo, referrer, day, count, uniques)
VALUES ('phdemotions/citegeist', 'github.com', DATE '2026-06-10', 3, 2);
INSERT INTO public.traffic_referrers (repo, referrer, day, count, uniques)
VALUES ('phdemotions/citegeist', 'github.com', DATE '2026-06-10', 8, 4)
ON CONFLICT (repo, referrer, day)
DO UPDATE SET count = EXCLUDED.count, uniques = EXCLUDED.uniques;
SELECT is(
  (SELECT count(*)::int FROM public.traffic_referrers
    WHERE repo = 'phdemotions/citegeist' AND referrer = 'github.com'
      AND day = DATE '2026-06-10'),
  1,
  'same-day referrer re-upsert keeps exactly one (repo, referrer, day) row'
);

-- ───────────────────────────────────────────────────────────────────────────
-- 4–6. 14-day self-healing window after a capture gap (KTD1)
-- ───────────────────────────────────────────────────────────────────────────
-- Simulate run #1: a full 14-day clones window ending 2026-06-05.
INSERT INTO public.traffic_daily (repo, metric, day, count, uniques)
SELECT
  'phdemotions/citegeist', 'clones',
  (DATE '2026-06-05' - g)::date, g + 1, g
FROM generate_series(0, 13) AS g
ON CONFLICT (repo, metric, day)
DO UPDATE SET count = EXCLUDED.count, uniques = EXCLUDED.uniques;

-- 4. Run #1 inserted 14 distinct days.
SELECT is(
  (SELECT count(*)::int FROM public.traffic_daily
    WHERE repo = 'phdemotions/citegeist' AND metric = 'clones'),
  14,
  '14-day window upsert inserts 14 distinct days'
);

-- Simulate run #2 FIVE days later: a full 14-day window ending 2026-06-10. The
-- windows OVERLAP on 9 days (2026-06-01 … 2026-06-05) and add 5 new days. This
-- is exactly the post-gap self-heal: the overlap re-upserts, the gap backfills.
INSERT INTO public.traffic_daily (repo, metric, day, count, uniques)
SELECT
  'phdemotions/citegeist', 'clones',
  (DATE '2026-06-10' - g)::date, 100 + g, 50 + g
FROM generate_series(0, 13) AS g
ON CONFLICT (repo, metric, day)
DO UPDATE SET count = EXCLUDED.count, uniques = EXCLUDED.uniques;

-- 5. The union of the two windows is 19 distinct days (14 + 5 new), with NO
--    duplication on the 9 overlapping days — the gap self-healed cleanly.
SELECT is(
  (SELECT count(*)::int FROM public.traffic_daily
    WHERE repo = 'phdemotions/citegeist' AND metric = 'clones'),
  19,
  'a 5-day-later window re-upsert backfills the gap with no duplication (self-heal)'
);

-- 5b (folded): an overlapping day carries run #2's corrected value, not run #1's.
SELECT is(
  (SELECT count FROM public.traffic_daily
    WHERE repo = 'phdemotions/citegeist' AND metric = 'clones'
      AND day = DATE '2026-06-05'),
  105,
  'an overlapping day is overwritten by the later run (no stale value survives)'
);

-- 6. Window-level uniques are stored in traffic_window and are DISTINCT from the
--    sum of the daily uniques (uniques are non-additive — the window total is
--    authoritative, KTD1). Sum of run #2 daily uniques (50..63) = 791; the
--    captured window uniques is a smaller, non-additive total.
INSERT INTO public.traffic_window (repo, metric, window_start, window_end, count, uniques)
VALUES ('phdemotions/citegeist', 'clones', DATE '2026-05-28', DATE '2026-06-10', 1500, 240);
SELECT ok(
  (SELECT uniques FROM public.traffic_window
    WHERE repo = 'phdemotions/citegeist' AND metric = 'clones')
  <> (SELECT COALESCE(sum(uniques), 0)::int FROM public.traffic_daily
        WHERE repo = 'phdemotions/citegeist' AND metric = 'clones'
          AND day BETWEEN DATE '2026-05-28' AND DATE '2026-06-10'),
  'window uniques (traffic_window) are stored distinct from the sum of daily uniques (non-additive)'
);

-- ───────────────────────────────────────────────────────────────────────────
-- 7–8. Backfill append idempotency (stars / forks)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO public.stars (repo, github_user, starred_at)
VALUES ('phdemotions/citegeist', 'octocat', TIMESTAMPTZ '2026-01-01T00:00:00Z');
INSERT INTO public.stars (repo, github_user, starred_at)
VALUES ('phdemotions/citegeist', 'octocat', TIMESTAMPTZ '2026-01-01T00:00:00Z')
ON CONFLICT (repo, github_user) DO NOTHING;
SELECT is(
  (SELECT count(*)::int FROM public.stars
    WHERE repo = 'phdemotions/citegeist' AND github_user = 'octocat'),
  1,
  're-appending the same stargazer is a no-op (UNIQUE repo, github_user)'
);

INSERT INTO public.forks (repo, fork_id, created_at)
VALUES ('phdemotions/citegeist', 987654321, TIMESTAMPTZ '2026-02-01T00:00:00Z');
INSERT INTO public.forks (repo, fork_id, created_at)
VALUES ('phdemotions/citegeist', 987654321, TIMESTAMPTZ '2026-02-01T00:00:00Z')
ON CONFLICT (repo, fork_id) DO NOTHING;
SELECT is(
  (SELECT count(*)::int FROM public.forks
    WHERE repo = 'phdemotions/citegeist' AND fork_id = 987654321),
  1,
  're-appending the same fork is a no-op (UNIQUE repo, fork_id)'
);

-- ───────────────────────────────────────────────────────────────────────────
-- 9–13. Watchdog staleness decision (gs_capture_watchdog)
-- ───────────────────────────────────────────────────────────────────────────

-- 9. The watchdog function and its pg_cron schedule both exist.
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gs_capture_watchdog'
  )
  AND EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'groundswell-capture-watchdog'
  ),
  'gs_capture_watchdog() and the groundswell-capture-watchdog pg_cron job exist'
);

-- 10. With zero capture runs, the watchdog is idle (RETURNs without alerting).
--     (No capture_runs rows yet — the perishable clock has not started.)
SELECT lives_ok(
  $$SELECT public.gs_capture_watchdog()$$,
  'watchdog is idle (no throw) when there are no capture runs yet'
);

-- 11. A FRESH successful run (now) → not stale → no alert, no throw.
INSERT INTO public.capture_runs (started_at, finished_at, status, last_successful_capture_at)
VALUES (now(), now(), 'success', now());
SELECT lives_ok(
  $$SELECT public.gs_capture_watchdog()$$,
  'watchdog does not alert on a fresh (<10d) successful capture'
);

-- 12. A STALE successful run (15 days ago) → over threshold → the alert branch is
--     reached; with no Vault endpoint configured it warns and RETURNs cleanly
--     (no pg_net dependency, no throw). Clear the fresh row first so max() is old.
DELETE FROM public.capture_runs;
INSERT INTO public.capture_runs (started_at, finished_at, status, last_successful_capture_at)
VALUES (now() - interval '15 days', now() - interval '15 days', 'success', now() - interval '15 days');
SELECT lives_ok(
  $$SELECT public.gs_capture_watchdog()$$,
  'watchdog reaches the alert branch on a stale (>10d) capture and returns cleanly without a Vault endpoint'
);

-- 13. The anchor is last_successful_capture_at, NOT started_at: a recent PARTIAL
--     run with a NULL anchor must not count as a successful capture. With only a
--     fresh partial (NULL anchor) plus the 15-day-old success, the effective
--     last-good stays the old success → still stale (the partial did not reset
--     the clock). Assert the effective last-good equals the old success.
INSERT INTO public.capture_runs (started_at, finished_at, status, last_successful_capture_at)
VALUES (now(), now(), 'partial', NULL);
SELECT ok(
  (SELECT max(last_successful_capture_at) FROM public.capture_runs)
    < (now() - interval '10 days'),
  'a partial run (NULL anchor) does not advance the watchdog clock (anchor stays the old success)'
);

SELECT * FROM finish();
ROLLBACK;
