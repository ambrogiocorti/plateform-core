begin;
drop trigger active_quota on public.dishes;
drop trigger active_quota on public.tables;
drop trigger active_quota on public.staff_profiles;
drop function private.enforce_active_quota();
-- Quotas are database invariants, including reactivation and every configuration RPC.
create function private.resource_quota_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare limits public.system_limits; resource_active boolean;
begin
  select * into limits from public.system_limits where id for update;
  if limits.id is null then return new;end if;
  resource_active:=case when tg_table_name='registered_devices' then to_jsonb(new)->>'revoked_at' is null else (to_jsonb(new)->>'active')::boolean end;
  if not resource_active then return new;end if;
  case tg_table_name
    when 'staff_profiles' then if (select count(*) from public.staff_profiles where active and id<>new.id)>=limits.max_users then raise exception 'USER_LIMIT';end if;
    when 'venues' then if (select count(*) from public.venues where active and id<>new.id)>=limits.max_venues then raise exception 'VENUE_LIMIT';end if;
    when 'tables' then if (select count(*) from public.tables where active and venue_id=new.venue_id and id<>new.id)>=limits.max_tables_per_venue then raise exception 'TABLE_LIMIT';end if;
    when 'dishes' then if (select count(*) from public.dishes where active and id<>new.id)>=limits.max_dishes then raise exception 'DISH_LIMIT';end if;
    when 'registered_devices' then if (select count(*) from public.registered_devices where revoked_at is null and id<>new.id)+(select count(*) from public.print_devices where active)>=limits.max_devices then raise exception 'DEVICE_LIMIT';end if;
    when 'print_devices' then if (select count(*) from public.registered_devices where revoked_at is null)+(select count(*) from public.print_devices where active and id<>new.id)>=limits.max_devices then raise exception 'DEVICE_LIMIT';end if;
  end case;
  return new;
end $$;
create trigger quota_guard before insert or update of active on public.staff_profiles for each row execute function private.resource_quota_guard();
create trigger quota_guard before insert or update of active on public.venues for each row execute function private.resource_quota_guard();
create trigger quota_guard before insert or update of active,venue_id on public.tables for each row execute function private.resource_quota_guard();
create trigger quota_guard before insert or update of active on public.dishes for each row execute function private.resource_quota_guard();
create trigger quota_guard before insert or update of revoked_at on public.registered_devices for each row execute function private.resource_quota_guard();
create trigger quota_guard before insert or update of active on public.print_devices for each row execute function private.resource_quota_guard();
create function private.validate_limit_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.max_users<(select count(*) from public.staff_profiles where active) or new.max_venues<(select count(*) from public.venues where active)
    or new.max_tables_per_venue<(select coalesce(max(n),0) from(select count(*) n from public.tables where active group by venue_id)x)
    or new.max_dishes<(select count(*) from public.dishes where active) or new.max_devices<(select count(*) from public.registered_devices where revoked_at is null)+(select count(*) from public.print_devices where active)
    or new.max_storage_bytes<(select coalesce(sum(size_bytes),0) from public.asset_uploads where status in ('RESERVED','SAVED')) then raise exception 'LIMIT_BELOW_CURRENT_USAGE';end if;
  return new;
end $$;
create trigger limit_usage_guard before insert or update on public.system_limits for each row execute function private.validate_limit_change();
commit;
