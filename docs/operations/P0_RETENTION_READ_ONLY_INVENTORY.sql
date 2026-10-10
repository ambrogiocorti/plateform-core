-- Plateform Development P0 — READ-ONLY retention risk inventory.
-- MUST NOT be modified into a DELETE/UPDATE/TRUNCATE script.
-- Running this query is not an authorization to purge anything.
--
-- Eligibility for deletion is ALWAYS false until independently verified
-- current-schema DB/Auth/Storage restore, off-site copy, audit and rollback.
WITH inventory AS (
  SELECT
    m.snapshot_id,
    b.status AS backup_status,
    b.purpose AS backup_purpose,
    m.row_count,
    EXISTS (
      SELECT 1 FROM public.restore_jobs r
      WHERE r.backup_id = m.snapshot_id
         OR r.pre_restore_backup_id = m.snapshot_id
    ) AS referenced_by_restore_job,
    EXISTS (
      SELECT 1 FROM private.continuity_rehearsal_transfer_key k
      WHERE k.snapshot_id = m.snapshot_id
    ) AS has_transfer_key,
    EXISTS (
      SELECT 1 FROM private.continuity_rehearsal_blob blob
      WHERE blob.snapshot_id = m.snapshot_id
    ) AS has_blob
  FROM private.continuity_rehearsal_snapshot_manifest m
  LEFT JOIN public.backup_metadata b ON b.id = m.snapshot_id
), transfer AS (
  SELECT snapshot_id, count(*) AS chunk_count,
         sum(octet_length(ciphertext)) AS cipher_bytes
  FROM private.continuity_rehearsal_transfer_chunks
  GROUP BY 1
)
SELECT
  coalesce(i.backup_status, 'ORPHANED_METADATA') AS backup_status,
  coalesce(i.backup_purpose, 'UNKNOWN') AS purpose,
  count(*) AS snapshot_count,
  sum(i.row_count) AS logical_snapshot_rows,
  sum(coalesce(t.chunk_count, 0)) AS encrypted_chunks,
  sum(coalesce(t.cipher_bytes, 0)) AS encrypted_payload_bytes,
  count(*) FILTER (WHERE i.referenced_by_restore_job) AS restore_job_references,
  count(*) FILTER (WHERE i.has_transfer_key) AS transfer_key_snapshots,
  count(*) FILTER (WHERE i.has_blob) AS blob_snapshots,
  count(*) FILTER (WHERE i.backup_status = 'FAILED'
    AND i.backup_purpose = 'SCHEDULED'
    AND NOT i.referenced_by_restore_job) AS preliminary_failed_unreferenced_candidates,
  false AS purge_authorized
FROM inventory i
LEFT JOIN transfer t ON t.snapshot_id = i.snapshot_id
GROUP BY coalesce(i.backup_status, 'ORPHANED_METADATA'),
         coalesce(i.backup_purpose, 'UNKNOWN')
ORDER BY backup_status, purpose;

-- Required independent capacity evidence: physical PostgreSQL bytes do not
-- shrink simply because rows were deleted.
SELECT
  now() AS observed_at,
  pg_database_size(current_database()) AS database_bytes,
  pg_total_relation_size('private.continuity_rehearsal_snapshot_rows') AS snapshot_relation_bytes,
  pg_total_relation_size('private.continuity_rehearsal_transfer_chunks') AS transfer_relation_bytes,
  (SELECT active FROM cron.job WHERE jobid = 4) AS automatic_backup_scheduler_active,
  (SELECT count(*) FROM public.backup_metadata
   WHERE status IN ('QUEUED', 'RUNNING')) AS outstanding_backup_jobs;
