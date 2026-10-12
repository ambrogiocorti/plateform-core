begin;
create function public.create_venue(p_name text,p_slug text,p_code text,p_address text,p_phone text,p_timezone text default 'Europe/Rome') returns uuid language plpgsql security definer set search_path='' as $$
declare ref uuid;
begin
  perform private.authorize(null,array['SUPER_ADMIN','ADMIN']::public.user_role[]);
  if private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.restaurant_profile where id for update;
  if not exists(select 1 from public.feature_flags where name='MULTI_VENUE' and licensed) then raise exception 'MULTI_VENUE_DISABLED'; end if;
  if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'INVALID_TIMEZONE'; end if;
  insert into public.venues(name,slug,code,address,phone,timezone) values(p_name,p_slug,p_code,p_address,p_phone,p_timezone) returning id into ref;
  insert into public.venue_settings(venue_id) values(ref);
  return ref;
end $$;
grant execute on function public.create_venue(text,text,text,text,text,text) to authenticated;

create function public.configure_booking_rules(p_venue uuid,p_service uuid,p_service_covers integer,p_interval integer,p_arrivals integer,p_slot_covers integer,p_auto_party integer,p_large_party text) returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  perform 1 from public.services where id=p_service and venue_id=p_venue for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  insert into public.service_booking_rules(venue_id,service_id,max_covers_service,slot_interval_minutes,max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm,large_party_mode)
    values(p_venue,p_service,p_service_covers,p_interval,p_arrivals,p_slot_covers,p_auto_party,p_large_party)
    on conflict(service_id) do update set max_covers_service=excluded.max_covers_service,slot_interval_minutes=excluded.slot_interval_minutes,
      max_arrivals_per_slot=excluded.max_arrivals_per_slot,max_covers_per_slot=excluded.max_covers_per_slot,max_party_size_auto_confirm=excluded.max_party_size_auto_confirm,large_party_mode=excluded.large_party_mode;
end $$;
grant execute on function public.configure_booking_rules(uuid,uuid,integer,integer,integer,integer,integer,text) to authenticated;

create function public.configure_venue_operations(p_venue uuid,p_values jsonb) returns void language plpgsql security definer set search_path='' as $$
declare k text; config public.venue_settings;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if jsonb_typeof(p_values)<>'object' or exists(select 1 from jsonb_object_keys(p_values) x where x not in ('reservations_enabled','customer_ordering','customer_bill_request','returns_enabled','step_starter_roles','delivery_routing','sounds')) then raise exception 'INVALID_SETTINGS'; end if;
  select * into config from public.venue_settings where venue_id=p_venue for update;
  if p_values ? 'customer_ordering' and p_values->>'customer_ordering'<>'DISABLED' and not exists(select 1 from public.feature_flags where name='CLIENT_ORDERING' and licensed) then raise exception 'FEATURE_NOT_LICENSED'; end if;
  for k in select jsonb_object_keys(p_values) loop
    execute format('update public.venue_settings s set %I=r.%I from jsonb_populate_record(null::public.venue_settings,$1) r where s.venue_id=$2',k,k) using p_values,p_venue;
  end loop;
end $$;
grant execute on function public.configure_venue_operations(uuid,jsonb) to authenticated;

-- Reject contradictory timezone and operational role configurations on every write path.
create function private.validate_venue() returns trigger language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from pg_timezone_names where name=new.timezone) then raise exception 'INVALID_TIMEZONE'; end if;
  return new;
end $$;
create trigger venue_timezone before insert or update on public.venues for each row execute function private.validate_venue();
alter table public.venue_settings add constraint permitted_step_roles check(step_starter_roles <@ array['WAITER','PASS','KITCHEN_ADMIN']::public.user_role[] and cardinality(step_starter_roles)>0);
alter table public.venue_settings add constraint permitted_delivery_routing check(delivery_routing <@ array['TABLE','ZONE','RUNNER'] and cardinality(delivery_routing)>0);
commit;
