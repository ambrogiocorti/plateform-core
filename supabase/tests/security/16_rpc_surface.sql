-- Every RPC executable by `authenticated`, called by venue-A staff of each role
-- and by an outsider with arguments pointing at venue-B resources (argument
-- names map to venue-B ids). Each call runs in a rolled-back subtransaction.
-- Invariants: no call by an outsider changes data or returns identifiers of
-- any venue; no call by venue-A staff returns an identifier of venue B.
begin;
\ir _seed.sql
create temp table fuzz_result(actor text, fn text, outcome text);
do $$
declare f record; args text; r text; actor text; argname text; i int; t oid; parts text[]; nm text[];
begin
  foreach actor in array array['admin_a','waiter_a','cashier_a','host_a','kstaff_a','outsider'] loop
  for f in select p.oid, p.oid::regprocedure::text sig, p.proname, string_to_array(p.proargtypes::text,' ')::oid[] types, p.proargnames names, p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and has_function_privilege('authenticated',p.oid,'execute') and p.prokind='f' and p.proname !~ '^get_public|^test_' order by 2 loop
    parts:='{}';
    for i in 1..coalesce(array_length(f.types,1),0) loop
      t:=f.types[i]; argname:=coalesce(f.names[i],'');
      parts:=parts||(case
        when t='uuid'::regtype then
          coalesce((select quote_literal(id)||'::uuid' from sec_obj where venue='b' and kind=case
            when argname ~ 'venue' then 'venue' when argname ~ 'reservation' then 'reservation' when argname ~ 'account' then 'account'
            when argname ~ 'order' then 'order' when argname ~ 'table' then 'table' when argname ~ 'layout' then 'layout' when argname ~ 'room' then 'room'
            when argname ~ 'register' then 'register' when argname ~ 'payment' then 'payment' when argname ~ 'notification' then 'notification'
            when argname ~ 'call' then 'call' when argname ~ 'upload|asset' then 'upload' when argname ~ 'service_session|session' then 'session'
            when argname ~ 'service' then 'service' end), 'gen_random_uuid()')
        when t in ('text'::regtype,'varchar'::regtype) then quote_literal('x')
        when t in ('integer'::regtype,'bigint'::regtype,'smallint'::regtype,'numeric'::regtype) then '1::'||format_type(t,null)
        when t='boolean'::regtype then 'true'
        when t='date'::regtype then 'current_date+1'
        when t='jsonb'::regtype then '''{}''::jsonb'
        else 'null::'||format_type(t,null) end);
    end loop;
    args:=array_to_string(parts,',');
    begin
      perform pg_temp.act(actor);
      execute format('select (public.%I(%s))::text', f.proname, args) into r;
      raise exception using errcode='PX001', message=left(coalesce(r,'<null>'),200);
    exception when sqlstate 'PX001' then
      execute 'reset role';
      insert into fuzz_result values(actor, f.sig, 'OK '||sqlerrm);
    when others then
      execute 'reset role';
      insert into fuzz_result values(actor, f.sig, 'ERR '||sqlstate||' '||left(sqlerrm,200));
    end;
  end loop;
  end loop;
end $$;
do $$
declare leak record;
begin
  for leak in
    select r.actor,r.fn,o.kind from fuzz_result r join sec_obj o on r.outcome like 'OK%' and r.outcome ilike '%'||o.id::text||'%'
    where o.venue='b' or r.actor='outsider'
  union all
    select r.actor,r.fn,'staff '||a.name from fuzz_result r join sec_actor a on r.outcome like 'OK%' and r.outcome ilike '%'||a.id::text||'%'
    where a.venue='00000000-0000-4000-8000-000000000b01' or (r.actor='outsider' and a.name<>'outsider')
  loop
    raise exception 'SECURITY_PROBE_FAILED: % via % receives % identifier',leak.actor,leak.fn,leak.kind;
  end loop;
  -- Any successful outsider call must be one of the reviewed self-service entry points.
  for leak in select fn from fuzz_result where actor='outsider' and outcome like 'OK%'
    and fn not in ('get_auth_requirements()','get_booking_configuration(uuid)','search_operational_resources(text,uuid)','unlock_staff_session(text)') loop
    raise exception 'SECURITY_PROBE_FAILED: outsider successfully calls %',leak.fn;
  end loop;
  perform pg_temp.expect((select count(*) from fuzz_result where actor='admin_a' and outcome like 'ERR 42501 VENUE_FORBIDDEN%')>=50,
    'cross-venue RPC probe is vacuous: too few VENUE_FORBIDDEN outcomes');
end $$;
rollback;
