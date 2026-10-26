DO $plateform$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.audit_log'::regclass
      AND tgname = 'audit_immutable' AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'AUDIT_IMMUTABILITY_GUARD_NOT_ENABLED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.audit_log'::regclass
      AND tgname = 'audit_no_truncate' AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'AUDIT_TRUNCATE_GUARD_NOT_ENABLED';
  END IF;
END
$plateform$;
ALTER TABLE public.audit_log DISABLE TRIGGER plateform_dev_pause_audit;
