-- ═══════════════════════════════════════════════════════════════════════════
-- pgTAP: RLS / trust-boundary assertions for the U2 snapshot model
-- Migration under test: supabase/migrations/00001_snapshot_model.sql
-- Plan: docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md (U2)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- RUN ORDER NOTE (GS-001): this script REQUIRES a live database with the
-- migration applied and the Supabase `anon`/`authenticated`/`service_role`
-- roles present. The dedicated Supabase project is not provisioned until U0 ops
-- (GS-001), so this runs AFTER GS-001:
--
--     supabase test db                              # runs every file in tests/
--     supabase test db supabase/tests/rls_snapshot_model.sql   # just this one
--
-- It is written test-first: the assertions encode the trust boundary the
-- migration must satisfy, and double as the U2 acceptance gate.
--
-- WHAT THIS COVERS (per the U2 test scenarios — 18 assertions):
--   1.  Structural: RLS is ENABLED on every base table.
--   2.  Structural: anon holds NO table privilege on any base table.
--   3.  anon cannot SELECT projects            (no unpublished roster / flags leak).
--   4.  anon cannot SELECT signal_snapshots.
--   5.  anon cannot SELECT traffic_daily.
--   6.  anon cannot SELECT traffic_window.
--   7.  anon cannot SELECT traffic_referrers.
--   8.  anon cannot SELECT stars.
--   9.  anon cannot SELECT forks.
--   10. anon cannot SELECT capture_runs        (capture telemetry stays private).
--   11. anon SELECT on public_showcase returns ONLY published rows (exactly 1).
--   12. public_showcase surfaces the published project (slug = citegeist).
--   13. public_showcase EXCLUDES soft-deleted + untracked + no-published-signal.
--   14. public_showcase.visibility exposes ONLY published (true) flags.
--   15. UNIQUE (repo, metric, day) rejects a duplicate non-upsert insert.
--   16. The same duplicate SUCCEEDS as an ON CONFLICT upsert (self-healing).
--   17. UNIQUE (repo, referrer, day) rejects a duplicate referrer insert.
--   18. authenticated also cannot SELECT a base table (no policy yet; U11 adds it).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT plan(18);

-- ───────────────────────────────────────────────────────────────────────────
-- Seed (runs as the test superuser, which bypasses RLS — mirrors service-role
-- writes). Fixtures are local to this transaction and rolled back at the end.
-- ───────────────────────────────────────────────────────────────────────────

-- A published, tracked, active project (should appear publicly).
INSERT INTO public.projects (id, owner, repo, slug, display_name, is_tracked, visibility)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'phdemotions', 'citegeist', 'citegeist', 'Citegeist',
  true,
  '{"downloads": true, "stars": true, "forks": false}'::jsonb
);

-- A tracked project with NO published signal (should NOT appear publicly).
INSERT INTO public.projects (id, owner, repo, slug, display_name, is_tracked, visibility)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  'phdemotions', 'private-repo', 'private-repo', 'Private Repo',
  true,
  '{"downloads": false, "stars": false}'::jsonb
);

-- A soft-deleted but otherwise-published project (should NOT appear publicly).
INSERT INTO public.projects (id, owner, repo, slug, display_name, is_tracked, visibility, deleted_at)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  'phdemotions', 'deleted-repo', 'deleted-repo', 'Deleted Repo',
  true,
  '{"stars": true}'::jsonb,
  now()
);

-- An untracked but published project (should NOT appear publicly).
INSERT INTO public.projects (id, owner, repo, slug, display_name, is_tracked, visibility)
VALUES (
  '44444444-4444-4444-4444-444444444444',
  'phdemotions', 'untracked-repo', 'untracked-repo', 'Untracked Repo',
  false,
  '{"stars": true}'::jsonb
);

-- A snapshot + capture telemetry + perishable rows, to prove anon can't read them.
INSERT INTO public.signal_snapshots (project_id, source, metric, value, data_class)
VALUES ('11111111-1111-1111-1111-111111111111', 'github', 'downloads', 1234, 'cumulative');

INSERT INTO public.traffic_daily (repo, metric, day, count, uniques)
VALUES ('phdemotions/citegeist', 'views', DATE '2026-06-01', 50, 10);

INSERT INTO public.traffic_window (repo, metric, window_start, window_end, count, uniques)
VALUES ('phdemotions/citegeist', 'views', DATE '2026-05-19', DATE '2026-06-01', 700, 120);

INSERT INTO public.traffic_referrers (repo, referrer, day, count, uniques)
VALUES ('phdemotions/citegeist', 'github.com', DATE '2026-06-01', 40, 8);

INSERT INTO public.stars (repo, github_user, starred_at)
VALUES ('phdemotions/citegeist', 'octocat', TIMESTAMPTZ '2026-01-01T00:00:00Z');

INSERT INTO public.forks (repo, fork_id, created_at)
VALUES ('phdemotions/citegeist', 987654321, TIMESTAMPTZ '2026-02-01T00:00:00Z');

INSERT INTO public.capture_runs (status, last_successful_capture_at)
VALUES ('success', now());

-- ───────────────────────────────────────────────────────────────────────────
-- 1–2. Structural guardrails (run as superuser, before switching role)
-- ───────────────────────────────────────────────────────────────────────────

-- 1. RLS enabled on every base table in the snapshot model.
SELECT is(
  (
    SELECT count(*)::int
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN (
        'projects', 'signal_snapshots', 'traffic_daily', 'traffic_window',
        'traffic_referrers', 'stars', 'forks', 'capture_runs'
      )
      AND NOT c.relrowsecurity
  ),
  0,
  'RLS is ENABLED on every snapshot-model base table'
);

-- 2. anon holds NO table privilege on any base table (belt-and-suspenders GRANT
--    revocation, independent of the no-policy default deny).
SELECT is(
  (
    SELECT count(*)::int
    FROM information_schema.role_table_grants g
    WHERE g.table_schema = 'public'
      AND g.grantee = 'anon'
      AND g.table_name IN (
        'projects', 'signal_snapshots', 'traffic_daily', 'traffic_window',
        'traffic_referrers', 'stars', 'forks', 'capture_runs'
      )
  ),
  0,
  'anon holds NO table privilege on any snapshot-model base table'
);

-- ───────────────────────────────────────────────────────────────────────────
-- 3–10. anon is DENY-ALL on every base table.
--
-- Because the anon GRANT is REVOKEd (not merely RLS-filtered), a direct SELECT
-- raises `permission denied` (SQLSTATE 42501) BEFORE any row is considered —
-- a strictly stronger boundary than "RLS returns 0 rows." We therefore assert
-- the THROW, not a count: a regression that re-grants anon would surface here
-- as a 0-row pass under RLS, so throws_ok('42501') is the precise guard.
-- ───────────────────────────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" TO '{"role":"anon"}';

-- 3. projects — must not leak the unpublished roster or visibility flags.
SELECT throws_ok(
  $$SELECT count(*) FROM public.projects$$,
  '42501',
  NULL,
  'anon cannot SELECT projects (no unpublished roster / visibility-flag leak)'
);

-- 4. signal_snapshots
SELECT throws_ok(
  $$SELECT count(*) FROM public.signal_snapshots$$,
  '42501',
  NULL,
  'anon cannot SELECT signal_snapshots'
);

-- 5. traffic_daily
SELECT throws_ok(
  $$SELECT count(*) FROM public.traffic_daily$$,
  '42501',
  NULL,
  'anon cannot SELECT traffic_daily'
);

-- 6. traffic_window
SELECT throws_ok(
  $$SELECT count(*) FROM public.traffic_window$$,
  '42501',
  NULL,
  'anon cannot SELECT traffic_window'
);

-- 7. traffic_referrers
SELECT throws_ok(
  $$SELECT count(*) FROM public.traffic_referrers$$,
  '42501',
  NULL,
  'anon cannot SELECT traffic_referrers'
);

-- 8. stars
SELECT throws_ok(
  $$SELECT count(*) FROM public.stars$$,
  '42501',
  NULL,
  'anon cannot SELECT stars'
);

-- 9. forks
SELECT throws_ok(
  $$SELECT count(*) FROM public.forks$$,
  '42501',
  NULL,
  'anon cannot SELECT forks'
);

-- 10. capture_runs — capture telemetry + error strings stay private.
SELECT throws_ok(
  $$SELECT count(*) FROM public.capture_runs$$,
  '42501',
  NULL,
  'anon cannot SELECT capture_runs'
);

-- ───────────────────────────────────────────────────────────────────────────
-- 11–14. public_showcase is the sole anon read path; published-only projection
-- ───────────────────────────────────────────────────────────────────────────

-- 11. Exactly the one published+tracked+active project surfaces.
SELECT is(
  (SELECT count(*)::int FROM public.public_showcase),
  1,
  'anon SELECT on public_showcase returns only published rows (exactly 1 here)'
);

-- 12 + 13. The excluded projects (deleted / untracked / no-published-signal) are
-- absent — assert the surfaced row is the citegeist one and the others are not.
SELECT is(
  (SELECT slug FROM public.public_showcase),
  'citegeist',
  'public_showcase surfaces the published project and excludes deleted/untracked/no-signal'
);

SELECT is(
  (SELECT count(*)::int FROM public.public_showcase
    WHERE slug IN ('deleted-repo', 'untracked-repo', 'private-repo')),
  0,
  'public_showcase excludes soft-deleted, untracked, and no-published-signal projects'
);

-- 14. visibility exposes ONLY the published (true) flags — the hidden "forks"
--     flag (false) must NOT appear, so anon can't learn what is deliberately hidden.
SELECT is(
  (SELECT visibility FROM public.public_showcase WHERE slug = 'citegeist'),
  '{"downloads": true, "stars": true}'::jsonb,
  'public_showcase.visibility exposes only published (true) per-signal flags'
);

-- Switch back to the privileged role for the constraint-level assertions, which
-- must INSERT (anon has no write grant — that is asserted structurally above).
RESET ROLE;

-- ───────────────────────────────────────────────────────────────────────────
-- 15–17. Uniqueness handling (KTD1 self-healing re-upsert)
-- ───────────────────────────────────────────────────────────────────────────

-- 15. A duplicate (repo, metric, day) plain INSERT is rejected (23505).
SELECT throws_ok(
  $$INSERT INTO public.traffic_daily (repo, metric, day, count, uniques)
    VALUES ('phdemotions/citegeist', 'views', DATE '2026-06-01', 99, 20)$$,
  '23505',
  NULL,
  'UNIQUE (repo, metric, day) rejects a duplicate non-upsert insert'
);

-- 16. The same duplicate SUCCEEDS as an ON CONFLICT upsert and OVERWRITES the
--     existing day (the 14-day self-healing re-upsert, R4 / KTD1).
SELECT lives_ok(
  $$INSERT INTO public.traffic_daily (repo, metric, day, count, uniques)
    VALUES ('phdemotions/citegeist', 'views', DATE '2026-06-01', 99, 20)
    ON CONFLICT (repo, metric, day)
    DO UPDATE SET count = EXCLUDED.count, uniques = EXCLUDED.uniques$$,
  'ON CONFLICT (repo, metric, day) upsert overwrites the existing day (self-healing)'
);

-- 17. (repo, referrer, day) uniqueness is enforced for referrers too.
SELECT throws_ok(
  $$INSERT INTO public.traffic_referrers (repo, referrer, day, count, uniques)
    VALUES ('phdemotions/citegeist', 'github.com', DATE '2026-06-01', 1, 1)$$,
  '23505',
  NULL,
  'UNIQUE (repo, referrer, day) rejects a duplicate referrer insert'
);

-- ───────────────────────────────────────────────────────────────────────────
-- 18. authenticated has no base-table policy yet either (U11 will add scoped
--     owner access). Until then, authenticated is also denied — proven on
--     projects as the representative case.
-- ───────────────────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}';

-- Same revoked-grant boundary as anon: a direct read raises 42501, not 0 rows.
SELECT throws_ok(
  $$SELECT count(*) FROM public.projects$$,
  '42501',
  NULL,
  'authenticated also cannot SELECT projects yet (no policy until U11)'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
