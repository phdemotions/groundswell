# Groundswell — Supabase

The snapshot store, trust boundary, and (later) derived views for Groundswell.
This is its **own dedicated Supabase project** (`public` schema), not a shared
instance — KTD11 in
[`docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md`](../docs/plans/2026-06-10-001-feat-groundswell-traction-showcase-plan.md).

## Layout

```
supabase/
├── migrations/
│   └── 00001_snapshot_model.sql   # U2 — tables + RLS (anon deny-all) + public_showcase view
├── tests/
│   └── rls_snapshot_model.sql     # pgTAP — the U2 trust-boundary assertions (test-first)
└── README.md                      # this file
```

Planned, not yet written: `00002_derived_views.sql` (U8 — derived read views),
`00003_watchdog.sql` (U4 — pg_cron freshness watchdog).

## The trust boundary (read this before touching RLS)

The whole point of the schema is a **hard anon/owner boundary** (KTD10):

- **RLS is `ENABLE`d + `FORCE`d on every base table.** There is **no anon (or
  authenticated) policy** on any base table, so the default is deny. Table
  privileges are **also `REVOKE`d** from `anon`/`authenticated` as an independent
  second guard — a future stray policy still can't open a table without a GRANT.
- **Writes are service-role only.** The service role bypasses RLS, so it needs no
  policy. The capture path (`src/lib/supabase/admin.ts`, `server-only`-guarded)
  is the only routine writer.
- **`public_showcase` is the SOLE anon read path.** It is a `security_invoker = on`
  view over the `gs_published_projects()` `SECURITY DEFINER` gate, which is the
  single auditable place the per-signal `projects.visibility` filter lives. anon
  has `SELECT` on the view and `EXECUTE` on the function — and deny-all on every
  base table, **including `projects`** (a direct `projects` SELECT must not leak
  the unpublished repo roster or the visibility flags).
- **Soft delete** via `projects.deleted_at`; the view excludes deleted rows.
- **`created_at`/`updated_at`** on `projects` with an `updated_at` trigger
  (`gs_set_updated_at`). Snapshot/append tables are immutable event rows and
  carry only their capture timestamps.

When you add a table, you **must** enable + force RLS and revoke client grants in
the **same migration** — never split the policy/RLS out.

## Uniques are non-additive (KTD1)

`traffic_daily.uniques` is a **per-day** count and must **never** be summed into a
window/monthly figure. The window-level unique total is captured **separately** in
`traffic_window.uniques` and is the only correct source for "uniques over the
window." The derived layer (U8) uses it directly. The 14-day self-healing
re-upsert keys on `UNIQUE (repo, metric, day)` (`ON CONFLICT DO UPDATE`);
referrers key on `UNIQUE (repo, referrer, day)`.

## Applying migrations

> **Blocked on GS-001 (U0 ops).** The dedicated Supabase project is not
> provisioned yet, so nothing below has been run against a live DB. This is the
> documented procedure for once it exists.

Migrations are plain SQL applied in filename order. With the Supabase CLI linked
to the dedicated project:

```bash
# one-time, after the project exists
supabase link --project-ref <groundswell-project-ref>

# apply the schema
supabase db push            # applies supabase/migrations/* in order
# or apply a single file via the dashboard SQL editor / MCP apply_migration
```

`00001_snapshot_model.sql` is wrapped in a single `BEGIN; … COMMIT;` and is
idempotent where practical (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`,
`DROP TRIGGER IF EXISTS`), so a re-apply against a partially-built DB is safe.

## Running the RLS tests

> **Also blocked on GS-001.** The pgTAP script needs a live DB with the
> migration applied and the Supabase `anon`/`authenticated`/`service_role`
> roles present. It is written **test-first**: the assertions encode the trust
> boundary the migration must satisfy and are the U2 acceptance gate.

```bash
supabase test db                                   # runs every file in tests/
supabase test db supabase/tests/rls_snapshot_model.sql   # just this one
```

`rls_snapshot_model.sql` covers (19 assertions): RLS enabled on every base
table; anon holds no table privilege; anon cannot SELECT any base table
(`projects`, `signal_snapshots`, `traffic_daily`, `traffic_window`,
`traffic_referrers`, `stars`, `forks`, `capture_runs`); `public_showcase`
returns only published rows and excludes soft-deleted / untracked /
no-published-signal projects; `visibility` exposes only published flags;
`(repo, metric, day)` and `(repo, referrer, day)` uniqueness; the `ON CONFLICT`
upsert overwrites (self-healing); authenticated is also denied until U11.

## Post-GS-001 follow-ups

1. **Provision the dedicated Supabase project** (U0 / GS-001), then apply
   `00001_snapshot_model.sql`.
2. **Regenerate the types.** `src/types/database.ts` is **hand-authored** today
   because `supabase gen types` needs a live DB. Once the DB exists, regenerate
   and replace it:
   ```bash
   supabase gen types typescript --linked > src/types/database.ts
   ```
3. **Run the RLS tests** (`supabase test db`) and confirm all assertions pass.
4. Wire `supabase test db` into the pre-push / CI path once the DB is reachable
   (mirrors the fourposts pre-push `supabase test db` gate).
