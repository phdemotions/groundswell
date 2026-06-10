-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: 00003_watchdog
-- Unit: U4 — Independent freshness watchdog (pg_cron + pg_net + Vault)
-- Plan: docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md
-- Requirements: R1 (capture liveness) · KTD3 (independent watchdog)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- GOAL: a DB-side freshness watchdog that is INDEPENDENT of the app-side Vercel
-- cron it monitors (KTD3). If the app scheduler dies, a watchdog co-located with
-- it would die too — so this lives in Postgres (pg_cron) and fires a real HTTP
-- alert (pg_net) when capture goes stale, with no dependency on the Next.js app.
--
-- ANCHOR: public.capture_runs.last_successful_capture_at — advanced by the
-- capture route ONLY on an all-ok batch (a partial-failure run does not reset
-- the clock, U4 / KTD3). The watchdog reads that anchor and alerts when it is
-- more than GS_STALE_THRESHOLD (10 days) old.
--
-- PRECEDENT: boxbox/supabase/migrations/20260309001200_cron_jobs.sql
--   (pg_net + pg_cron + Vault `service_role_key`). This migration generalizes the
--   pattern: BOTH the alert URL and the alert secret are read from Supabase Vault
--   so no alert endpoint is committed to the repo and the target (Sentry ingest /
--   a Vercel alert route / a Telegram bot — KTD3) can change without a migration.
--
-- ───────────────────────────────────────────────────────────────────────────
-- ONE-TIME SETUP (run ONCE in the SQL Editor after applying this migration; do
-- NOT commit real secret values). Until these Vault secrets exist the watchdog
-- runs but no-ops with a warning (it never sends to a missing endpoint):
--
--   SELECT vault.create_secret('groundswell_alert_url',    'https://<your-alert-endpoint>');
--   SELECT vault.create_secret('groundswell_alert_secret', '<shared-bearer-or-ingest-key>');
--
-- The alert endpoint must accept a JSON POST with a Bearer auth header. For a
-- Vercel alert route, reuse a dedicated secret (NOT CRON_SECRET). For Sentry,
-- point the URL at the store/ingest endpoint and the secret at the DSN key.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Extensions — pg_cron (scheduling) + pg_net (HTTP from SQL)
-- ───────────────────────────────────────────────────────────────────────────
-- pg_cron must be created in its own schema; pg_net lives in `extensions`
-- (Supabase convention). Both are idempotent.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. gs_capture_watchdog() — the freshness check + alert
-- ───────────────────────────────────────────────────────────────────────────
-- Runs under pg_cron. Determines the effective "last good capture" as:
--   • the most recent last_successful_capture_at across capture_runs, OR
--   • when capture has run but NEVER succeeded, the FIRST run's started_at
--     (so a deploy that captures-but-always-fails for >10 days still alerts).
-- Alerts ONLY when capture has actually started (≥1 capture_runs row) AND the
-- effective last-good is older than the staleness threshold. A brand-new DB with
-- zero runs does not alert — the perishable clock starts when U4 first runs.
--
-- SECURITY DEFINER + pinned search_path: the function reads capture_runs and the
-- Vault decrypted view as the (privileged) owner. It is NOT granted to anon /
-- authenticated — only pg_cron (the postgres role) invokes it.
CREATE OR REPLACE FUNCTION public.gs_capture_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  -- 10-day staleness threshold (KTD3). The capture cron runs daily, so 10 days
  -- is ~10 consecutive missed/failed runs — well clear of a single transient
  -- failure, and inside KTD1's 14-consecutive-dark-day permanent-loss window so
  -- the alert lands BEFORE perishable traffic data is gone for good.
  v_stale_threshold CONSTANT interval := interval '10 days';

  v_run_count   bigint;
  v_last_good   timestamptz;
  v_first_run   timestamptz;
  v_effective   timestamptz;
  v_age         interval;

  v_alert_url    text;
  v_alert_secret text;
  v_request_id   bigint;
BEGIN
  -- How many capture runs exist, the latest success, and the first attempt.
  SELECT
    count(*),
    max(last_successful_capture_at),
    min(started_at)
  INTO v_run_count, v_last_good, v_first_run
  FROM public.capture_runs;

  -- Capture has never run → the perishable clock hasn't started. Do not alert.
  IF v_run_count = 0 THEN
    RAISE LOG 'gs_capture_watchdog: no capture runs yet — watchdog idle.';
    RETURN;
  END IF;

  -- Effective last-good: a real success if we have one, else the first attempt
  -- (captures-but-never-succeeds is itself an alertable failure after 10 days).
  v_effective := COALESCE(v_last_good, v_first_run);
  v_age := now() - v_effective;

  IF v_age <= v_stale_threshold THEN
    -- Fresh enough — nothing to do.
    RETURN;
  END IF;

  -- ── Stale. Pull the alert endpoint + secret from Vault. ───────────────────
  SELECT decrypted_secret INTO v_alert_url
  FROM vault.decrypted_secrets
  WHERE name = 'groundswell_alert_url'
  LIMIT 1;

  SELECT decrypted_secret INTO v_alert_secret
  FROM vault.decrypted_secrets
  WHERE name = 'groundswell_alert_secret'
  LIMIT 1;

  IF v_alert_url IS NULL OR v_alert_secret IS NULL THEN
    -- Fail LOUD in the logs but never POST to a missing/blank endpoint.
    RAISE WARNING 'gs_capture_watchdog: capture STALE by % but Vault secrets '
      'groundswell_alert_url / groundswell_alert_secret are not set — run '
      'vault.create_secret(...) (see 00003_watchdog.sql). No alert sent.', v_age;
    RETURN;
  END IF;

  -- ── Fire the alert (fire-and-forget HTTP POST via pg_net). ────────────────
  SELECT net.http_post(
    url := v_alert_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_alert_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'source', 'groundswell-capture-watchdog',
      'level', 'error',
      'message', 'Groundswell capture is stale: no successful capture in over 10 days. Perishable GitHub traffic data is at risk (permanent loss after 14 dark days).',
      'last_successful_capture_at', v_last_good,
      'first_capture_attempt_at', v_first_run,
      'stale_for_seconds', EXTRACT(EPOCH FROM v_age)::bigint,
      'capture_run_count', v_run_count
    )
  ) INTO v_request_id;

  RAISE LOG 'gs_capture_watchdog: capture STALE by % — alert POSTed (request_id=%).',
    v_age, v_request_id;
END;
$$;

COMMENT ON FUNCTION public.gs_capture_watchdog() IS
  'Independent freshness watchdog (KTD3). Alerts via pg_net when '
  'capture_runs.last_successful_capture_at is stale >10 days. URL + secret read '
  'from Supabase Vault (groundswell_alert_url / groundswell_alert_secret). '
  'Invoked by pg_cron only; not granted to anon/authenticated.';

-- The watchdog is invoked exclusively by pg_cron (the postgres superuser). Strip
-- the broad default EXECUTE so it is never callable on the anon/authenticated
-- API surface (it can POST an alert + reads capture telemetry).
REVOKE EXECUTE ON FUNCTION public.gs_capture_watchdog() FROM PUBLIC, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Schedule the watchdog (idempotent) — daily at 18:00 UTC
-- ───────────────────────────────────────────────────────────────────────────
-- Deliberately offset from the capture cron (07:00 UTC, vercel.json) so the
-- watchdog reads a settled anchor, never mid-run. Idempotent: unschedule inside
-- a guard (so a missing job on first apply doesn't error) then (re)schedule.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('groundswell-capture-watchdog');
    EXCEPTION WHEN OTHERS THEN
      -- No existing job to unschedule on first apply — ignore.
      NULL;
    END;

    PERFORM cron.schedule(
      'groundswell-capture-watchdog',
      '0 18 * * *',
      'SELECT public.gs_capture_watchdog()'
    );
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-MIGRATION FOLLOW-UPS (tracked in supabase/README.md + STATUS/ISSUES)
-- ═══════════════════════════════════════════════════════════════════════════
-- • GS-001 (U0 ops): this migration applies only after the dedicated Supabase
--   project exists. pg_cron + pg_net must be enabled for the project (Supabase
--   Dashboard → Database → Extensions, or these CREATE EXTENSION lines).
-- • One-time: create the two Vault secrets above (groundswell_alert_url /
--   groundswell_alert_secret). Until then the watchdog logs a WARNING and does
--   not POST.
-- • Verify the alert path end-to-end once: temporarily lower the threshold or
--   seed an old capture_runs row in a NON-production branch, run
--   `SELECT public.gs_capture_watchdog();`, and confirm the endpoint receives
--   the POST.
-- ═══════════════════════════════════════════════════════════════════════════
