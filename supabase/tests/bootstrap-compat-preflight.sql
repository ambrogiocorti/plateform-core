-- Read-only preflight for the replay-only bootstrap compatibility migrations
-- listed in supabase/migration-bootstrap-compat.json.
-- Run it on an existing installation (for example Development) BEFORE recording
-- 20261006100100 and 20261012075300 with `supabase migration repair --status applied`.
-- It issues no DDL/DML; the transaction is READ ONLY and rolled back.
-- Every row must report ok = true; the last row is the overall verdict.
BEGIN TRANSACTION READ ONLY;

WITH history AS (
  SELECT version FROM supabase_migrations.schema_migrations
),
rehearsal(name) AS (
  VALUES
    ('continuity_rehearsal_blob'),
    ('continuity_rehearsal_key'),
    ('continuity_rehearsal_snapshot_manifest'),
    ('continuity_rehearsal_snapshot_rows'),
    ('continuity_rehearsal_snapshot_tables'),
    ('continuity_rehearsal_transfer_chunks'),
    ('continuity_rehearsal_transfer_key')
),
rehearsal_state AS (
  SELECT r.name,
         c.oid IS NOT NULL AS present,
         coalesce(c.relrowsecurity, false) AS rls,
         coalesce(
           has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
           OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'),
           false
         ) AS client_access
  FROM rehearsal r
  LEFT JOIN pg_catalog.pg_class c
    ON c.relname = r.name
   AND c.relnamespace = 'private'::regnamespace
   AND c.relkind = 'r'
),
checks(ord, check_name, ok, detail) AS (
  SELECT 1, 'history_contains_20261006100248',
         EXISTS (SELECT 1 FROM history WHERE version = '20261006100248'),
         'the migration 20261006100100 compensates for must already be applied'
  UNION ALL
  SELECT 2, 'history_contains_20261012075338',
         EXISTS (SELECT 1 FROM history WHERE version = '20261012075338'),
         'the migration 20261012075300 compensates for must already be applied'
  UNION ALL
  SELECT 3, 'compat_versions_not_yet_recorded',
         NOT EXISTS (
           SELECT 1 FROM history WHERE version IN ('20261006100100', '20261012075300')
         ),
         'repair is needed only while both versions are missing'
  UNION ALL
  SELECT 4, 'rehearsal_tables_present',
         bool_and(present),
         coalesce(string_agg(name, ',') FILTER (WHERE NOT present), 'all seven present')
  FROM rehearsal_state
  UNION ALL
  SELECT 5, 'rehearsal_tables_rls_enabled',
         bool_and(rls),
         coalesce(string_agg(name, ',') FILTER (WHERE NOT rls), 'rls enabled on all seven')
  FROM rehearsal_state
  UNION ALL
  SELECT 6, 'rehearsal_tables_no_client_access',
         NOT bool_or(client_access),
         coalesce(
           string_agg(name, ',') FILTER (WHERE client_access),
           'no anon/authenticated table privilege'
         )
  FROM rehearsal_state
  UNION ALL
  SELECT 7, 'audit_pause_trigger_not_enabled',
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger t
           WHERE t.tgname = 'plateform_dev_pause_audit'
             AND t.tgenabled <> 'D'
             AND t.tgrelid IN (
               SELECT relid FROM pg_catalog.pg_partition_tree('public.audit_log'::regclass)
             )
         ),
         'an enabled pause trigger would discard audit inserts: stop and investigate'
)
SELECT check_name, ok, detail
FROM (
  SELECT ord, check_name, ok, detail FROM checks
  UNION ALL
  SELECT 99, 'BOOTSTRAP_COMPAT_REPAIR_ALLOWED', bool_and(ok),
         'record both versions as applied only when this is true'
  FROM checks
) verdict
ORDER BY ord;

ROLLBACK;
