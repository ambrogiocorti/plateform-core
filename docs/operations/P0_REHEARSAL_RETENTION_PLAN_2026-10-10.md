# P0 Continuity Rehearsal Retention — Safety Plan (2026-10-10)

Status: BLOCKED until an independently recoverable, current-version backup and isolated restore have been verified.

## Live inventory
- Project: `plateform-development`.
- Snapshot manifests: **155**, total size remains above the Supabase Free database limit.
- Of those manifests: 90 belong to FAILED scheduled backups, 59 to SUCCEEDED scheduled backups, 4 to SUCCEEDED restore-test-purpose backups, 1 to a FAILED restore-test-purpose backup, and 1 is not joined to `public.backup_metadata`.
- The 90 failed scheduled snapshots account for about 1,188,514 logical snapshot rows. **Not** an estimate of physical bytes saved by pruning.
- Last successful scheduled backup has schema version `20261009001127`, is marked integrity-verified with replica metadata, but **no fresh isolated restore has been proven**.
- The replica target project is INACTIVE. Metadata flags do not prove byte-level recoverability while it is inaccessible.
- Automatic scheduling (pg_cron job 4) was disabled, the backup queue is empty, and snapshot count was stable at 155 at the last read.
- A foreign key `continuity_rehearsal_snapshot_rows_snapshot_id_fkey` cascades on manifest deletion. Other snapshot-associated tables do **not** all share this FK: deleting a manifest is not a safe complete purge.

## Fail-closed retention sequence
1. Keep the schedule disabled until the receiver is restored, authenticated readiness is demonstrated, and Edge version compatibility is verified.
2. Verify actual backup bytes in **primary and independent replica**, migration-history SHA-256, Auth, Storage object bytes, encryption key escrow, and all ledger/audit data.
3. Complete a fresh restore test on a **new isolated target** with the same schema version and actual DB/Auth/Storage content, then record RPO and RTO observed.
4. Build a per-`snapshot_id` reference inventory: backup_metadata status/purpose, restore dependencies, manifest presence, chunks, keys, tables, and Storage objects. Protect all successful or referenced recovery material.
5. Dry-run a candidate list restricted to obsolete FAILED rehearsal artifacts, but do not equate FAILED with disposable. Retain enough diagnostics to prove the fault cause and rollback.
6. Rehearse the exact cleanup on disposable staging data. Audit deleted identifiers and verified backup copies, bound execution to an explicit allowlist, and stop on unexpected references.
7. Only after the rehearsal and approved backup evidence, execute a bounded production-like cleanup with rollback planning. Do **not** use a broad `TRUNCATE`, unfiltered `DELETE` or manual Storage purge.
8. Assess appropriate PostgreSQL reclaim operations and resource/locking impact. A row `DELETE` does not immediately reduce physical database size. Record before/after metrics, checksums and alarms.
9. Re-enable job 4 only after a successful backup and restore, rate-limited retention and quota alerts.

## Read-only candidate inspection
```sql
select b.status, b.purpose, count(*) as snapshots, sum(m.row_count) as logical_rows
from private.continuity_rehearsal_snapshot_manifest m
left join public.backup_metadata b on b.id = m.snapshot_id
group by b.status, b.purpose
order by snapshots desc;

select pg_database_size(current_database()) as bytes,
       (select count(*) from private.continuity_rehearsal_snapshot_manifest) as snapshots,
       (select active from cron.job where jobid = 4) as schedule_active;
```

This is a plan, not permission to delete data and not a release certification. On-call owner, current commit, test logs, resource references, and a fresh restore confirmation are required before any purge.
