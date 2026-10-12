-- QA fixture maintenance. Do not weaken session validation in application code.
-- The test has an intentional nested rollback; renew its seed session only there.
do $patch$
declare
  v_definition text;
  v_old text := 'set unlocked_until=clock_timestamp()+interval ''30 minutes''';
  v_new text := 'set unlocked_until=clock_timestamp()+interval ''30 minutes'', full_auth_at=clock_timestamp(), full_auth_expires_at=clock_timestamp()+interval ''30 minutes''';
begin
  select pg_catalog.pg_get_functiondef('private.test_notification_center_e2e()'::regprocedure)
    into v_definition;
  if v_definition is null or pg_catalog.strpos(v_definition,v_old)=0
    then raise exception 'NOTIFICATION_PROBE_SOURCE_CHANGED';
  end if;
  if has_function_privilege('anon','private.test_notification_center_e2e()','EXECUTE')
     or has_function_privilege('authenticated','private.test_notification_center_e2e()','EXECUTE')
    then raise exception 'NOTIFICATION_PROBE_MUST_STAY_PRIVATE';
  end if;
  execute pg_catalog.replace(v_definition,v_old,v_new);
end
$patch$;