-- Verbatim SQL from applied remote migration 20261011064608
-- Reference only until the remote/local 459-migration history is reconciled.
CREATE OR REPLACE FUNCTION public.list_failed_continuity_storage_cleanup(
  p_limit integer DEFAULT 10
)
RETURNS TABLE(backup_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $body$
  SELECT b.id
  FROM public.backup_metadata b
  WHERE p_limit BETWEEN 1 AND 15
    AND b.status='FAILED'
    AND b.integrity_verified IS DISTINCT FROM TRUE
    AND b.completed_at < now()-interval '10 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM public.restore_jobs r
      WHERE r.backup_id=b.id OR r.pre_restore_backup_id=b.id
    )
    AND EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id='plateform-continuity-primary'
        AND o.name LIKE b.id::text || '/%'
    )
  ORDER BY b.completed_at,b.id
  LIMIT LEAST(greatest(p_limit,1),15)
$body$;
REVOKE ALL ON FUNCTION public.list_failed_continuity_storage_cleanup(integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_failed_continuity_storage_cleanup(integer) TO service_role;
