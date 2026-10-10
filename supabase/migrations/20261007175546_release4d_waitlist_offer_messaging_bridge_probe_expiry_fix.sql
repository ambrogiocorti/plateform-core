
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid)
  into v_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private'
    and p.proname='test_waitlist_offer_message_bridge';

  v_def:=replace(
    v_def,
    'update public.waitlist_entries
    set offer_expires_at=clock_timestamp()-interval ''1 second''
    where id=v_expired_entry;',
    'update public.waitlist_entries
    set offered_at=clock_timestamp()-interval ''2 minutes'',
        offer_expires_at=clock_timestamp()-interval ''1 minute''
    where id=v_expired_entry;'
  );

  execute v_def;
end
$$;
