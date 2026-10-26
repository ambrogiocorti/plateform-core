# P0 — Continuity capacity preflight (11 October 2026)

This preflight is **read-only**. It does not delete rehearsal snapshots, alter cron, change database schema, enable backups or certify recovery.

## Verified development baseline, 2026-10-11 06:02 UTC

- Project: `plateform-development` (`abdxvlykasqmknexxhjo`), PostgreSQL 17.11.
- Database: 1,570,543,283 bytes; remote migrations: 457.
- Rehearsal snapshots: 155; latest 2026-10-10 08:55 UTC; stored rehearsal rows: 1,716,997; transfer chunks: 8,664.
- The automatic `enqueue_due_backup()` cron job (job 4) is **already inactive**. No queued or running backup jobs were found.
- Latest successful integrity-verified scheduled backup: 2026-10-09 08:37 UTC (schema version `20261009001127`). Subsequent scheduled backup attempts failed through 2026-10-10 08:55 UTC.
- The main space consumers are `private.continuity_rehearsal_snapshot_rows` and `private.continuity_rehearsal_transfer_chunks`.

These readings are a **point-in-time diagnostic**, not a go-live acceptance or proof of a restore.

## Run (read-only)

Use a secure secret injection mechanism, not hard-coded connection details:

```bash
export SUPABASE_DB_URL='postgresql://...'
export PLATEFORM_DB_CAPACITY_BYTES=500000000
node scripts/continuity-capacity-preflight.mjs
node scripts/continuity-capacity-preflight.mjs --self-test
```

Optionally configure `PLATEFORM_BACKUP_MAX_AGE_HOURS` (default 24). Set the capacity limit to the actual allocation for the target project, not the example quota. Exit: 0 healthy, 1 warning, 2 critical or query/configuration error. The result is structured JSON suitable for a monitored runner. Credentials never appear in the report.

## Safety / next release gates

1. Preserve at least one **independently verified** usable copy of database/Auth/Storage and associated manifests/encryption keys before removing any rehearsal artifacts.
2. Audit snapshot dependencies and ensure cleanup cannot invalidate active restore jobs or audit. Never run blanket `DELETE` or `TRUNCATE` on private continuity tables.
3. Distinguish reclaimable logical rows from physical PostgreSQL disk space; plan safe reclamation and verify storage quota afterwards.
4. Reconcile the 457 remote migration statements against canonical versioned source files and hashes, then reproduce a clean isolated staging install.
5. Re-run full backup+restore on the current schema/version and validate external durability, RPO/RTO and restore integrity.

**Status: P0 IN PROGRESS; go-live NO-GO.** CI self-tests validate preflight logic only. There is deliberately no automatic DB cleanup and no change to production release gates.
