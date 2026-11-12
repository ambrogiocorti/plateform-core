begin;
create function public.begin_impersonation(p_subject uuid,p_reason text,p_grant uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare ref uuid; previous jsonb;
begin perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  previous:=private.idempotency_begin('impersonation',p_key,jsonb_build_object('subject',p_subject,'reason',p_reason));if previous is not null then return previous;end if;
  perform private.consume_step_up(p_grant,'IMPERSONATION',p_subject);
  if p_subject=auth.uid() or not exists(select 1 from public.staff_profiles where id=p_subject and active) or p_reason is null or length(trim(p_reason)) not between 8 and 2000 then raise exception 'INVALID_IMPERSONATION';end if;
  update private.impersonation_sessions set ended_at=now() where actor_id=auth.uid() and session_id=private.jwt_session_id() and ended_at is null;
  insert into private.impersonation_sessions(actor_id,subject_id,session_id,reason,expires_at) values(auth.uid(),p_subject,private.jwt_session_id(),p_reason,now()+interval '15 minutes') returning id into ref;
  perform private.audit('IMPERSONATION_STARTED','staff_profiles',p_subject,null,null,jsonb_build_object('reason',p_reason));
  return private.idempotency_finish('impersonation',p_key,jsonb_build_object('id',ref,'write_enabled',false));
end $$;
grant execute on function public.begin_impersonation(uuid,text,uuid,uuid) to authenticated;
create function public.get_impersonation_context(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare session private.impersonation_sessions; subject public.staff_profiles;
begin if private.real_role() is distinct from 'SUPER_ADMIN' then raise exception 'FORBIDDEN';end if;
  select * into session from private.impersonation_sessions where id=p_id and actor_id=auth.uid() and session_id=private.jwt_session_id() and ended_at is null and expires_at>now();
  if session.id is null then raise exception 'IMPERSONATION_EXPIRED';end if;
  select * into subject from public.staff_profiles where id=session.subject_id and active;if subject.id is null then raise exception 'IMPERSONATION_EXPIRED';end if;
  return jsonb_build_object('id',session.id,'write_enabled',session.write_enabled,'expires_at',session.expires_at,'profile',jsonb_build_object('id',subject.id,'display_name',subject.display_name,'role',subject.role,'scope',subject.scope,'active',subject.active,'version',subject.version));
end $$;
grant execute on function public.get_impersonation_context(uuid) to authenticated;
create function public.enable_impersonation_write(p_id uuid,p_confirm boolean,p_grant uuid) returns void language plpgsql security definer set search_path='' as $$
begin if private.real_role() is distinct from 'SUPER_ADMIN' or p_confirm is distinct from true then raise exception 'FORBIDDEN';end if;
  perform private.consume_step_up(p_grant,'IMPERSONATION',p_id);
  update private.impersonation_sessions set write_enabled=true where id=p_id and actor_id=auth.uid() and session_id=private.jwt_session_id() and ended_at is null and expires_at>now();if not found then raise exception 'IMPERSONATION_EXPIRED';end if;
  perform private.audit('IMPERSONATION_WRITE_ENABLED','impersonation_sessions',p_id,null,null,jsonb_build_object('enabled',true));
end $$;
grant execute on function public.enable_impersonation_write(uuid,boolean,uuid) to authenticated;
create function public.end_impersonation(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin if private.real_role() is distinct from 'SUPER_ADMIN' then raise exception 'FORBIDDEN';end if;
  perform private.audit('IMPERSONATION_ENDED','impersonation_sessions',p_id,null);
  update private.impersonation_sessions set ended_at=coalesce(ended_at,now()) where id=p_id and actor_id=auth.uid() and session_id=private.jwt_session_id();
end $$;
grant execute on function public.end_impersonation(uuid) to authenticated;
create function public.configure_system_limits(p_limits jsonb,p_grant uuid) returns void language plpgsql security definer set search_path='' as $$
begin perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);perform private.consume_step_up(p_grant,'FEATURE_CHANGE');
  if p_limits is null or not p_limits ?& array['max_users','max_venues','max_tables_per_venue','max_dishes','max_devices','max_storage_bytes'] or p_limits-array['max_users','max_venues','max_tables_per_venue','max_dishes','max_devices','max_storage_bytes']<>'{}' then raise exception 'INVALID_LIMITS';end if;
  perform 1 from public.system_limits where id for update;
  if (p_limits->>'max_users')::int<(select count(*) from public.staff_profiles where active) or (p_limits->>'max_venues')::int<(select count(*) from public.venues where active)
    or (p_limits->>'max_tables_per_venue')::int<(select coalesce(max(n),0) from (select count(*) n from public.tables where active group by venue_id) x)
    or (p_limits->>'max_dishes')::int<(select count(*) from public.dishes where active) or (p_limits->>'max_devices')::int<(select count(*) from public.registered_devices where revoked_at is null) then raise exception 'LIMIT_BELOW_CURRENT_USAGE';end if;
  update public.system_limits set max_users=(p_limits->>'max_users')::int,max_venues=(p_limits->>'max_venues')::int,max_tables_per_venue=(p_limits->>'max_tables_per_venue')::int,max_dishes=(p_limits->>'max_dishes')::int,max_devices=(p_limits->>'max_devices')::int,max_storage_bytes=(p_limits->>'max_storage_bytes')::bigint where id;
  perform private.audit('SYSTEM_LIMITS_CHANGED','system_limits',null,null,null,p_limits);
end $$;
grant execute on function public.configure_system_limits(jsonb,uuid) to authenticated;
-- Central URL configuration supports the authorized same-origin /staff deployment.
create or replace function public.setup_installation(p_name text,p_public_url text,p_staff_url text,p_identity_domain text,p_venue jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v uuid;
begin perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);perform pg_advisory_xact_lock(71467001);
  if exists(select 1 from public.restaurant_profile) then raise exception 'ALREADY_CONFIGURED';end if;
  if p_public_url is null or p_staff_url is null or p_public_url !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/?$' or p_staff_url !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?(/[a-zA-Z0-9_-]+)*/?$' or rtrim(p_staff_url,'/')=rtrim(p_public_url,'/') then raise exception 'HTTPS_AREA_URL_REQUIRED';end if;
  if p_identity_domain is null or p_identity_domain !~ '^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' then raise exception 'INVALID_IDENTITY_DOMAIN';end if;
  insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain) values(p_name,rtrim(p_public_url,'/'),rtrim(p_staff_url,'/'),lower(p_identity_domain));
  insert into public.restaurant_settings(id) values(true);insert into public.system_limits(id) values(true);
  insert into public.venues(name,slug,code,address,phone,timezone,currency,locale) values(p_venue->>'name',p_venue->>'slug',p_venue->>'code',p_venue->>'address',p_venue->>'phone',coalesce(p_venue->>'timezone','Europe/Rome'),coalesce(p_venue->>'currency','EUR'),coalesce(p_venue->>'locale','it-IT')) returning id into v;
  insert into public.venue_settings(venue_id) values(v);return v;
end $$;
commit;
