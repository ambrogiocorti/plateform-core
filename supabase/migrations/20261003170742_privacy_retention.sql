begin;
alter table public.reservations add column anonymized_at timestamptz;
alter table public.reservations add column privacy_hold boolean not null default false;
alter table public.reservations add column privacy_hold_reason text;
create index reservations_retention on public.reservations(service_date) where anonymized_at is null and not privacy_hold;
create table private.customer_identity_retention(user_id uuid primary key references auth.users(id) on delete cascade,eligible_at timestamptz not null,
  status text not null default 'PENDING' check(status in ('PENDING','RUNNING','PSEUDONYMIZED','FAILED')),lease_token uuid,lease_until timestamptz,completed_at timestamptz,attempts integer not null default 0);
revoke all on private.customer_identity_retention from public,anon,authenticated;
insert into private.customer_identity_retention(user_id,eligible_at)
  select auth_user_id,max(expires_at)+make_interval(days=>coalesce((select (retention->>'customer_session_days')::integer from public.restaurant_settings where id),30)) from private.customer_sessions
  where not exists(select 1 from public.staff_profiles where id=auth_user_id) group by auth_user_id;

alter function public.authorize_sensitive_action(text,uuid) rename to authorize_sensitive_action_base;
alter function public.authorize_sensitive_action_base(text,uuid) set schema private;
revoke all on function private.authorize_sensitive_action_base(text,uuid) from public,anon,authenticated;
create function public.authorize_sensitive_action(p_action text,p_resource uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare venue uuid; actor uuid;
begin
  if p_action<>'PRIVACY' then return private.authorize_sensitive_action_base(p_action,p_resource);end if;
  if p_resource is not null then select venue_id into venue from public.reservations where id=p_resource;if venue is null then raise exception 'NOT_FOUND';end if;end if;
  actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
  if p_resource is null and private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED';end if;
  if private.impersonation_id() is not null then raise exception 'EXIT_IMPERSONATION_FOR_STEP_UP';end if;
  return jsonb_build_object('user_id',actor,'session_id',private.jwt_session_id());
end $$;
grant execute on function public.authorize_sensitive_action(text,uuid) to authenticated;

create function public.search_privacy_reservations(p_venue uuid,p_phone text,p_after uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[],false);
  if p_phone is null or length(trim(p_phone)) not between 5 and 50 then raise exception 'INVALID_SEARCH';end if;
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from (select id,venue_id,first_name,last_name,phone,service_date,slot_time,status,version,anonymized_at,privacy_hold,privacy_hold_reason
    from public.reservations where (p_venue is null or venue_id=p_venue) and private.has_venue(venue_id) and phone=trim(p_phone) and (p_after is null or id>p_after) order by id limit 51) r),'[]');
end $$;
grant execute on function public.search_privacy_reservations(uuid,text,uuid) to authenticated;
create function public.export_reservation_personal_data(p_reservation uuid,p_grant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.reservations; result jsonb;
begin
  select * into r from public.reservations where id=p_reservation;if r.id is null then raise exception 'NOT_FOUND';end if;
  perform private.authorize(r.venue_id,array['ADMIN']::public.user_role[]);perform private.consume_step_up(p_grant,'PRIVACY',r.id);
  result:=jsonb_build_object('exported_at',now(),'reservation',jsonb_build_object('id',r.id,'venue_id',r.venue_id,'first_name',r.first_name,'last_name',r.last_name,'phone',r.phone,'service_date',r.service_date,'slot_time',r.slot_time,'party_size',r.party_size,'status',r.status,'customer_note',r.customer_note,'allergies',r.allergies,'created_at',r.created_at,'anonymized_at',r.anonymized_at),
    'answers',coalesce((select jsonb_agg(jsonb_build_object('field',f.label,'answer',a.answer) order by f.sort_order) from public.reservation_answers a join public.reservation_form_fields f on f.id=a.field_id where a.reservation_id=r.id),'[]'));
  perform private.audit('PERSONAL_DATA_EXPORTED','reservations',r.id,r.venue_id,null,jsonb_build_object('status',r.status));return result;
end $$;
grant execute on function public.export_reservation_personal_data(uuid,uuid) to authenticated;
create function public.change_reservation_privacy(p_reservation uuid,p_version bigint,p_action text,p_changes jsonb,p_reason text,p_grant uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.reservations; result jsonb;
begin
  select * into r from public.reservations where id=p_reservation for update;if r.id is null then raise exception 'NOT_FOUND';end if;
  perform private.authorize(r.venue_id,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('reservation_privacy',p_key,jsonb_build_object('reservation',p_reservation,'version',p_version,'action',p_action,'changes',p_changes,'reason',p_reason));if result is not null then return result;end if;
  if r.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if p_action is null or p_action not in ('RECTIFY','ANONYMIZE','HOLD','RELEASE_HOLD') or p_changes is null or jsonb_typeof(p_changes)<>'object' or p_reason is null or length(trim(p_reason)) not between 8 and 1000 then raise exception 'INVALID_PRIVACY_REQUEST';end if;
  perform private.consume_step_up(p_grant,'PRIVACY',r.id);
  if p_action='RECTIFY' then
    if r.anonymized_at is not null or p_changes-array['first_name','last_name','phone']<>'{}' or jsonb_typeof(p_changes->'first_name') is distinct from 'string' or length(trim(p_changes->>'first_name')) not between 1 and 100
      or jsonb_typeof(p_changes->'last_name') is distinct from 'string' or length(p_changes->>'last_name')>100 or jsonb_typeof(p_changes->'phone') is distinct from 'string' or length(trim(p_changes->>'phone')) not between 5 and 50 then raise exception 'INVALID_PRIVACY_REQUEST';end if;
    update public.reservations set first_name=trim(p_changes->>'first_name'),last_name=trim(p_changes->>'last_name'),phone=trim(p_changes->>'phone') where id=r.id;
  elsif p_action='ANONYMIZE' then
    if p_changes<>'{}' or r.privacy_hold then raise exception 'PRIVACY_HOLD';end if;
    if r.status not in ('COMPLETED','CANCELLED','NO_SHOW') or r.service_date>current_date then raise exception 'RESERVATION_STILL_ACTIVE';end if;
    update public.reservations set first_name='Ospite',last_name='',phone='anon:'||r.id::text,customer_note=null,internal_note=null,allergies=null,anonymized_at=now() where id=r.id;
    delete from public.reservation_answers where reservation_id=r.id;
  else
    if p_changes<>'{}' then raise exception 'INVALID_PRIVACY_REQUEST';end if;
    update public.reservations set privacy_hold=p_action='HOLD',privacy_hold_reason=case when p_action='HOLD' then trim(p_reason) end where id=r.id;
  end if;
  perform private.audit('PERSONAL_DATA_'||p_action,'reservations',r.id,r.venue_id,jsonb_build_object('version',r.version),jsonb_build_object('status',r.status));
  select jsonb_build_object('id',id,'version',version) into result from public.reservations where id=r.id;
  return private.idempotency_finish('reservation_privacy',p_key,result);
end $$;
grant execute on function public.change_reservation_privacy(uuid,bigint,text,jsonb,text,uuid,uuid) to authenticated;

create function public.configure_data_retention(p_version bigint,p_settings jsonb,p_grant uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; key text; old_days integer;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);if private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED';end if;
  perform 1 from public.restaurant_settings where id for update;
  result:=private.idempotency_begin('retention_settings',p_key,jsonb_build_object('version',p_version,'settings',p_settings));if result is not null then return result;end if;
  if (select version from public.restaurant_settings where id) is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if p_settings is null or jsonb_typeof(p_settings)<>'object' or p_settings-array['reservation_days','customer_session_days','telemetry_days','error_days','signal_days','enabled']<>'{}' or jsonb_typeof(p_settings->'enabled') is distinct from 'boolean' then raise exception 'INVALID_RETENTION';end if;
  foreach key in array array['reservation_days','customer_session_days','telemetry_days','error_days','signal_days'] loop
    if jsonb_typeof(p_settings->key) is distinct from 'number' or p_settings->>key !~ '^[0-9]+$' or (p_settings->>key)::numeric not between 1 and 3650 then raise exception 'INVALID_RETENTION';end if;
  end loop;
  perform private.consume_step_up(p_grant,'PRIVACY');
  select coalesce((retention->>'customer_session_days')::integer,30) into old_days from public.restaurant_settings where id;
  update private.customer_identity_retention set eligible_at=eligible_at+make_interval(days=>(p_settings->>'customer_session_days')::integer-old_days) where status='PENDING';
  update public.restaurant_settings set retention=p_settings||jsonb_build_object('configured_by',private.effective_user_id(),'configured_at',now()) where id returning jsonb_build_object('version',version) into result;
  perform private.audit('RETENTION_CONFIGURED','restaurant_settings',null,null,null,jsonb_build_object('enabled',(p_settings->>'enabled')::boolean));
  return private.idempotency_finish('retention_settings',p_key,result);
end $$;
grant execute on function public.configure_data_retention(bigint,jsonb,uuid,uuid) to authenticated;
create function public.get_privacy_configuration() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform private.authorize(null,array['ADMIN']::public.user_role[],false);
  if private.current_scope()<>'CHAIN' then return null;end if;
  return (select jsonb_build_object('version',version,'retention',retention) from public.restaurant_settings where id);
end $$;
grant execute on function public.get_privacy_configuration() to authenticated;

create function public.register_customer_identity_retention(p_user uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  if p_user is null or not exists(select 1 from auth.users where id=p_user) or exists(select 1 from public.staff_profiles where id=p_user) then raise exception 'CUSTOMER_IDENTITY_REQUIRED';end if;
  insert into private.customer_identity_retention(user_id,eligible_at) values(p_user,now()+interval '12 hours'+make_interval(days=>coalesce((select (retention->>'customer_session_days')::integer from public.restaurant_settings where id),30)))
    on conflict(user_id) do nothing;
end $$;
grant execute on function public.register_customer_identity_retention(uuid) to service_role;
create function public.run_data_retention(p_limit integer default 200) returns jsonb language plpgsql security definer set search_path='' as $$
declare config jsonb; rows_count integer; reservations_count integer:=0; sessions_count integer:=0; telemetry_count integer:=0; errors_count integer:=0; signals_count integer:=0; ref uuid;
begin
  if p_limit is null or p_limit not between 1 and 1000 then raise exception 'INVALID_LIMIT';end if;
  perform pg_advisory_xact_lock(71467540);
  select retention into config from public.restaurant_settings where id;
  if config->>'enabled' is distinct from 'true' or not config ? 'configured_at' then return jsonb_build_object('enabled',false);end if;
  for ref in select id from public.reservations where anonymized_at is null and not privacy_hold and status in ('COMPLETED','CANCELLED','NO_SHOW') and service_date<current_date-(config->>'reservation_days')::integer order by service_date,id limit p_limit for update skip locked loop
    update public.reservations set first_name='Ospite',last_name='',phone='anon:'||ref::text,customer_note=null,internal_note=null,allergies=null,anonymized_at=now() where id=ref;
    delete from public.reservation_answers where reservation_id=ref;reservations_count:=reservations_count+1;
    perform private.audit('RETENTION_ANONYMIZED','reservations',ref,(select venue_id from public.reservations where id=ref));
  end loop;
  delete from private.customer_access_codes where account_id in(select account_id from private.customer_access_codes where expires_at<now() order by expires_at limit p_limit);
  update private.customer_sessions set revoked_at=now() where id in(select id from private.customer_sessions where revoked_at is null and expires_at<=now() order by expires_at limit p_limit);
  delete from private.customer_sessions where id in(select id from private.customer_sessions where coalesce(revoked_at,expires_at)<now()-make_interval(days=>(config->>'customer_session_days')::integer) and expires_at<=now() order by expires_at limit p_limit);get diagnostics sessions_count=row_count;
  delete from public.telemetry_events where id in(select id from public.telemetry_events where created_at<now()-make_interval(days=>(config->>'telemetry_days')::integer) order by created_at limit p_limit);get diagnostics telemetry_count=row_count;
  delete from public.system_errors where id in(select id from public.system_errors where created_at<now()-make_interval(days=>(config->>'error_days')::integer) order by created_at limit p_limit);get diagnostics errors_count=row_count;
  delete from public.realtime_signals where id in(select id from public.realtime_signals where created_at<now()-make_interval(days=>(config->>'signal_days')::integer) order by created_at limit p_limit);get diagnostics signals_count=row_count;
  rows_count:=reservations_count+sessions_count+telemetry_count+errors_count+signals_count;
  if rows_count>0 then perform private.audit('DATA_RETENTION_APPLIED','restaurant_settings',null,null,null,jsonb_build_object('status','APPLIED'));end if;
  return jsonb_build_object('enabled',true,'reservations_anonymized',reservations_count,'sessions_removed',sessions_count,'telemetry_removed',telemetry_count,'errors_removed',errors_count,'signals_removed',signals_count);
end $$;
grant execute on function public.run_data_retention(integer) to service_role;
create function public.claim_customer_identity_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare row private.customer_identity_retention;
begin
  if (select retention->>'enabled' from public.restaurant_settings where id) is distinct from 'true' then return null;end if;
  select * into row from private.customer_identity_retention q where q.eligible_at<=now() and (q.status in ('PENDING','FAILED') or q.status='RUNNING' and q.lease_until<=now()) and q.attempts<10
    and not exists(select 1 from public.staff_profiles where id=q.user_id) and not exists(select 1 from private.customer_sessions where auth_user_id=q.user_id and revoked_at is null and expires_at>now()) order by q.eligible_at limit 1 for update skip locked;
  if row.user_id is null then return null;end if;
  update private.customer_identity_retention set status='RUNNING',lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1 where user_id=row.user_id returning * into row;
  update private.customer_sessions set revoked_at=now() where auth_user_id=row.user_id and revoked_at is null;
  return jsonb_build_object('user_id',row.user_id,'lease_token',row.lease_token);
end $$;
grant execute on function public.claim_customer_identity_cleanup() to service_role;
create function public.finish_customer_identity_cleanup(p_user uuid,p_lease uuid,p_success boolean) returns void language plpgsql security definer set search_path='' as $$
begin
  if p_success is null or not exists(select 1 from private.customer_identity_retention where user_id=p_user and lease_token=p_lease and status='RUNNING') then raise exception 'LEASE_CONFLICT';end if;
  update private.customer_identity_retention set status=case when p_success then 'PSEUDONYMIZED' else 'FAILED' end,completed_at=case when p_success then now() end,eligible_at=case when p_success then eligible_at else now()+make_interval(mins=>30*attempts) end,lease_until=null where user_id=p_user and lease_token=p_lease;
  perform private.audit(case when p_success then 'CUSTOMER_IDENTITY_PSEUDONYMIZED' else 'CUSTOMER_IDENTITY_CLEANUP_FAILED' end,'customer_identity',p_user,null,null,jsonb_build_object('status',case when p_success then 'PSEUDONYMIZED' else 'FAILED' end));
end $$;
grant execute on function public.finish_customer_identity_cleanup(uuid,uuid,boolean) to service_role;
commit;
