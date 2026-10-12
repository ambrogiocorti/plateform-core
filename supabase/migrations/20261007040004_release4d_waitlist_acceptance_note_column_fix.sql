do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='accept_waitlist_offer'
    and pg_get_function_identity_arguments(p.oid)='p_entry uuid, p_access_token text, p_key uuid';

  if v_def is null then raise exception 'FUNCTION_NOT_FOUND'; end if;
  if position('host_note' in v_def)=0 then raise exception 'EXPECTED_COLUMN_NOT_FOUND'; end if;

  execute replace(v_def,'host_note','customer_note');
end
$$;