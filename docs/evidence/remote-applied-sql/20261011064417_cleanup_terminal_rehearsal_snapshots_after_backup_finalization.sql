-- Verbatim SQL from applied remote migration 20261011064417
-- Reference only until the remote/local 459-migration history is reconciled.
CREATE OR REPLACE FUNCTION private.cleanup_finished_rehearsal_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NEW.status NOT IN ('SUCCEEDED','FAILED')
     OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status='SUCCEEDED' AND (
    NEW.integrity_verified IS DISTINCT FROM true
    OR NEW.verification->'replica' IS DISTINCT FROM 'true'::jsonb
    OR NEW.verification->'manifest_auth' IS DISTINCT FROM 'true'::jsonb
    OR NEW.verification->'database' IS DISTINCT FROM 'true'::jsonb
    OR NEW.verification->'storage' IS DISTINCT FROM 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'REHEARSAL_CLEANUP_REQUIRES_VERIFIED_DURABLE_BACKUP';
  END IF;

  DELETE FROM private.continuity_rehearsal_transfer_chunks
   WHERE snapshot_id=NEW.id;
  DELETE FROM private.continuity_rehearsal_snapshot_tables
   WHERE snapshot_id=NEW.id;
  DELETE FROM private.continuity_rehearsal_transfer_key
   WHERE snapshot_id=NEW.id;
  DELETE FROM private.continuity_rehearsal_snapshot_rows
   WHERE snapshot_id=NEW.id;
  DELETE FROM private.continuity_rehearsal_snapshot_manifest
   WHERE snapshot_id=NEW.id;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION private.cleanup_finished_rehearsal_snapshot()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cleanup_terminal_rehearsal_snapshot ON public.backup_metadata;
CREATE TRIGGER cleanup_terminal_rehearsal_snapshot
AFTER UPDATE OF status ON public.backup_metadata
FOR EACH ROW
WHEN (NEW.status IN ('SUCCEEDED','FAILED')
      AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION private.cleanup_finished_rehearsal_snapshot();
