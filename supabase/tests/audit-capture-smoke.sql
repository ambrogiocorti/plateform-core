-- Non-destructive audit insert smoke test for an isolated environment.
-- The INSERT is always rolled back in a PL/pgSQL exception subtransaction.
-- Must run with a privileged testing role after checking the audit schema.
DO $test$
DECLARE
  v_id uuid := gen_random_uuid();
  v_seen boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.audit_log'::regclass
      AND tgname = 'audit_immutable' AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'AUDIT_IMMUTABILITY_GUARD_NOT_ENABLED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.audit_log'::regclass
      AND tgname = 'plateform_dev_pause_audit' AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'AUDIT_PAUSE_TRIGGER_STILL_ACTIVE';
  END IF;
  BEGIN
    INSERT INTO public.audit_log
      (id, actor_type, action, resource_type, operation, result, correlation_id, request_id, metadata)
    VALUES
      (v_id, 'SYSTEM', 'AUDIT_RESTORE_SMOKE_TEST', 'AUDIT_PIPELINE',
       'INSERT', 'SUCCESS', gen_random_uuid(), gen_random_uuid(),
       '{"transient":true}'::jsonb);
    SELECT EXISTS (
      SELECT 1 FROM public.audit_log WHERE id = v_id
    ) INTO v_seen;
    IF NOT v_seen THEN RAISE EXCEPTION 'AUDIT_TEST_INSERT_NOT_VISIBLE'; END IF;
    RAISE EXCEPTION 'ROLLBACK_EXPECTED';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'ROLLBACK_EXPECTED' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.audit_log WHERE id = v_id) THEN
    RAISE EXCEPTION 'AUDIT_TEST_ROLLBACK_FAILED';
  END IF;
  RAISE NOTICE 'AUDIT_CAPTURE_SMOKE_TEST_PASSED';
END $test$;
