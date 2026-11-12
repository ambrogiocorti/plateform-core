begin;
create table public.health_checks (
  id uuid primary key default gen_random_uuid(), component text not null check(component in ('DATABASE','AUTH','REALTIME','STORAGE','EDGE','STRIPE','SATISPAY','PRINT','BACKUP')),
  status text not null check(status in ('HEALTHY','DEGRADED','UNAVAILABLE','DISABLED','UNVERIFIED')),
  latency_ms integer check(latency_ms between 0 and 60000), code text not null check(code in ('PROBE_OK','PROBE_FAILED','PROBE_TIMEOUT','DISABLED','CONFIGURED_UNTESTED')),
  checked_at timestamptz not null default now(), request_id uuid not null
);
alter table public.health_checks enable row level security;
revoke all on public.health_checks from public,anon,authenticated;
grant select on public.health_checks to authenticated;
create policy technical_read on public.health_checks for select to authenticated using(private.current_role()='SUPER_ADMIN');
create index health_component_recent on public.health_checks(component,checked_at desc);
create function public.authorize_health_probe() returns boolean language plpgsql stable security definer set search_path='' as $$
begin perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[],false);return true;end $$;
grant execute on function public.authorize_health_probe() to authenticated;
create function public.service_database_probe() returns boolean language sql stable security definer set search_path='' as $$select true$$;
grant execute on function public.service_database_probe() to service_role;
create function public.record_health_probe(p_component text,p_status text,p_latency integer,p_code text,p_request uuid) returns void language plpgsql security definer set search_path='' as $$
begin insert into public.health_checks(component,status,latency_ms,code,request_id) values(p_component,p_status,p_latency,p_code,p_request);end $$;
grant execute on function public.record_health_probe(text,text,integer,text,uuid) to service_role;
create function public.get_technical_workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[],false);
  return jsonb_build_object(
    'profile',(select jsonb_build_object('name',name,'status',status,'version',version,'public_base_url',public_base_url,'staff_base_url',staff_base_url,'staff_identity_domain',staff_identity_domain) from public.restaurant_profile where id),
    'settings',(select to_jsonb(s) from public.restaurant_settings s where id),
    'limits',(select to_jsonb(l) from public.system_limits l where id),
    'features',coalesce((select jsonb_agg(to_jsonb(f) order by name) from public.feature_flags f),'[]'),
    'health',coalesce((select jsonb_agg(to_jsonb(x) order by component) from (select distinct on(component) component,status,latency_ms,code,checked_at from public.health_checks order by component,checked_at desc,id desc)x),'[]'),
    'backups',coalesce((select jsonb_agg(to_jsonb(x) order by created_at desc) from(select * from public.backup_metadata order by created_at desc,id desc limit 10)x),'[]'),
    'releases',coalesce((select jsonb_agg(to_jsonb(x) order by released_at desc) from(select * from public.application_releases order by released_at desc,id desc limit 10)x),'[]'),
    'schema_version',(select max(version) from public.database_migrations_metadata),
    'incidents',coalesce((select jsonb_agg(to_jsonb(x) order by started_at desc) from(select * from public.incidents where status<>'RESOLVED' order by started_at desc,id desc limit 50)x),'[]'),
    'usage',jsonb_build_object('users',(select count(*) from public.staff_profiles where active),'venues',(select count(*) from public.venues where active),'tables',(select count(*) from public.tables where active),
      'dishes',(select count(*) from public.dishes where active),'devices',(select count(*) from public.registered_devices where revoked_at is null)+(select count(*) from public.print_devices where active),
      'recent_devices',(select count(*) from public.registered_devices where revoked_at is null and last_seen_at>now()-interval '5 minutes'),
      'sessions',(select count(*) from private.staff_sessions where revoked_at is null and unlocked_until>now()),
      'storage_bytes',(select coalesce(sum(size_bytes),0) from public.asset_uploads where status in ('RESERVED','SAVED'))),
    'queues',jsonb_build_object('offline_pending',(select count(*) from public.offline_sync_events where sync_status in ('PENDING','SYNCING')),'sync_conflicts',(select count(*) from public.sync_conflicts where status='OPEN'),
      'print_pending',(select count(*) from public.print_jobs where status='QUEUED'),'print_uncertain',(select count(*) from public.print_jobs where status in ('SENT','FAILED')),
      'provider_pending',(select count(*) from public.provider_operations where state in ('NEW','IN_FLIGHT','WAITING')),'provider_manual_review',(select count(*) from public.provider_operations where state in ('NEW','IN_FLIGHT','WAITING') and first_requested_at<now()-interval '20 hours' and provider_id is null),
      'staff_manual_review',(select count(*) from public.staff_admin_jobs where status='MANUAL_REVIEW'))
  );
end $$;
grant execute on function public.get_technical_workspace() to authenticated;
create function public.configure_authentication(p_version bigint,p_admin_mfa boolean,p_cashier_mfa boolean,p_full_auth integer,p_offline_ttl integer,p_grant uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;settings public.restaurant_settings;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('authentication_config',p_key,jsonb_build_object('version',p_version,'admin_mfa',p_admin_mfa,'cashier_mfa',p_cashier_mfa,'full_auth',p_full_auth,'offline_ttl',p_offline_ttl));if result is not null then return result;end if;
  perform private.consume_step_up(p_grant,'FEATURE_CHANGE');
  select * into settings from public.restaurant_settings where id for update;if settings.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if p_admin_mfa is null or p_cashier_mfa is null or p_full_auth is null or p_full_auth not between 30 and 720 or p_offline_ttl is null or p_offline_ttl not between 5 and 120 or p_offline_ttl>p_full_auth then raise exception 'INVALID_SETTINGS';end if;
  update public.restaurant_settings set admin_mfa_required=p_admin_mfa,cashier_mfa_required=p_cashier_mfa,full_auth_minutes=p_full_auth,offline_ttl_minutes=p_offline_ttl where id;
  update public.offline_authorization_snapshots set revoked_at=now() where revoked_at is null;
  perform private.audit('AUTHENTICATION_CONFIG_CHANGED','restaurant_settings',null,null,null,jsonb_build_object('version',settings.version+1));
  return private.idempotency_finish('authentication_config',p_key,jsonb_build_object('version',settings.version+1));
end $$;
grant execute on function public.configure_authentication(bigint,boolean,boolean,integer,integer,uuid,uuid) to authenticated;
create function public.save_feature_license(p_name text,p_licensed boolean,p_version bigint,p_grant uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('feature_license',p_key,jsonb_build_object('name',p_name,'licensed',p_licensed,'version',p_version));if result is not null then return result;end if;
  perform 1 from public.feature_flags where name=p_name and version=p_version for update;if not found then raise exception 'VERSION_CONFLICT';end if;
  if p_licensed is null then raise exception 'INVALID_SETTINGS';end if;
  perform public.configure_feature(p_name,p_licensed,p_grant);
  return private.idempotency_finish('feature_license',p_key,jsonb_build_object('name',p_name,'licensed',p_licensed));
end $$;
grant execute on function public.save_feature_license(text,boolean,bigint,uuid,uuid) to authenticated;
create or replace function public.set_installation_status(p_status public.installation_status,p_step_up uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare current_status public.installation_status;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_reason is null or length(trim(p_reason)) not between 8 and 2000 then raise exception 'REASON_REQUIRED';end if;
  select status into current_status from public.restaurant_profile where id for update;
  if not ((current_status='ACTIVE' and p_status='SUSPENDED') or (current_status='SUSPENDED' and p_status='ACTIVE')) or p_status is null then raise exception 'INVALID_TRANSITION';end if;
  perform private.consume_step_up(p_step_up,'INSTALLATION_STATUS');
  update public.restaurant_profile set status=p_status where id;
  perform private.audit('INSTALLATION_STATUS_CHANGED','restaurant_profile',null,null,jsonb_build_object('status',current_status),jsonb_build_object('status',p_status,'reason',trim(p_reason)));
end $$;
create function public.change_installation_status(p_status public.installation_status,p_version bigint,p_reason text,p_grant uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('installation_status',p_key,jsonb_build_object('status',p_status,'version',p_version,'reason',p_reason));if result is not null then return result;end if;
  perform 1 from public.restaurant_profile where id and version=p_version for update;if not found then raise exception 'VERSION_CONFLICT';end if;
  perform public.set_installation_status(p_status,p_grant,p_reason);
  return private.idempotency_finish('installation_status',p_key,jsonb_build_object('status',p_status));
end $$;
grant execute on function public.change_installation_status(public.installation_status,bigint,text,uuid,uuid) to authenticated;
commit;
