do $patch$
declare src text;
begin
  src:=pg_get_functiondef('private.test_step11_public_booking_transaction()'::regprocedure);
  if position('pg_catalog.coalesce' in src)=0 then raise exception 'TEST_SCHEMA_CHANGED'; end if;
  execute replace(src,'pg_catalog.coalesce','coalesce');
end $patch$;