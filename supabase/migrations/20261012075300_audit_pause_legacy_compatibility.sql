-- Compatibility with a legacy Development-only audit pause trigger.
-- Create it disabled, solely so the following historical DISABLE statement
-- succeeds in an isolated clean replay. Never suppress audit inserts.
BEGIN;
CREATE OR REPLACE FUNCTION private.plateform_legacy_audit_pause_noop()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION private.plateform_legacy_audit_pause_noop()
  FROM PUBLIC, anon, authenticated;
DO $plateform$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.audit_log'::regclass
      AND tgname = 'plateform_dev_pause_audit'
  ) THEN
    EXECUTE 'CREATE TRIGGER plateform_dev_pause_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION private.plateform_legacy_audit_pause_noop()';
  END IF;
END
$plateform$;
ALTER TABLE public.audit_log DISABLE TRIGGER plateform_dev_pause_audit;
COMMIT;
