-- Forward-only activation contract. Existing installations keep browser/PDF
-- printing; granting EPSON_PRINTING still requires the technical step-up RPC.
begin;

alter table public.feature_flags drop constraint feature_flags_name_check;
alter table public.feature_flags add constraint feature_flags_name_check check(name=any(array[
  'MULTI_VENUE','CLIENT_ORDERING','STRIPE','SATISPAY_API','OFFLINE',
  'ADVANCED_ROOM_EDITOR','ADVANCED_ANALYTICS','RESERVATION_MESSAGING',
  'WHATSAPP_TELEGRAM_SMS_MESSAGING','BOOKING_DEPOSITS','WAITLIST','TAKEAWAY',
  'FOOD_COST','MENU_PROMOTIONS','MULTI_MENU_QR','EPSON_PRINTING'
]::text[]));

insert into public.feature_flags(name,licensed)
values('EPSON_PRINTING',false) on conflict(name) do nothing;

create or replace function private.external_printing_licensed()
returns boolean language plpgsql security definer set search_path='' as $$
declare enabled boolean;
begin
  -- Serialize dispatch/configuration with licence revocation. A stale caller
  -- must not queue another external job while the licence is being withdrawn.
  select licensed into enabled from public.feature_flags
  where name='EPSON_PRINTING' for share;
  return coalesce(enabled,false);
end $$;
revoke all on function private.external_printing_licensed() from public,anon,authenticated;

create or replace function private.core_edition_print_driver_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.driver='BROWSER' then return new; end if;
  if tg_op='UPDATE' and not new.active and new.driver is not distinct from old.driver then
    return new;
  end if;
  if new.driver not in ('EPOS','BRIDGE') or not private.external_printing_licensed() then
    raise exception 'PRINT_DRIVER_NOT_INCLUDED';
  end if;
  return new;
end $$;
revoke all on function private.core_edition_print_driver_guard() from public,anon,authenticated;

create or replace function private.core_edition_print_job_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare device public.print_devices;
begin
  select * into device from public.print_devices
  where id=new.print_device_id and venue_id=new.venue_id and active;
  if device.id is null or
     (device.driver<>'BROWSER' and not private.external_printing_licensed()) then
    raise exception 'CORE_PRINT_DEVICE_FORBIDDEN';
  end if;
  return new;
end $$;
revoke all on function private.core_edition_print_job_guard() from public,anon,authenticated;

create or replace function private.print_authorize(p_device uuid)
returns public.print_devices language plpgsql security definer set search_path='' as $$
declare d public.print_devices;
begin
  select * into d from public.print_devices where id=p_device and active;
  if d.id is null then raise exception 'INVALID_PRINT_DEVICE'; end if;
  perform private.authorize(d.venue_id,array['ADMIN','CASHIER','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[]);
  if not private.current_role()=any(d.allowed_roles) then raise exception 'PRINT_FORBIDDEN'; end if;
  if d.driver<>'BROWSER' and not private.external_printing_licensed() then
    raise exception 'PRINT_DRIVER_NOT_INCLUDED';
  end if;
  return d;
end $$;
revoke all on function private.print_authorize(uuid) from public,anon,authenticated;

create or replace function private.external_printing_revocation_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.name='EPSON_PRINTING' and old.licensed and not new.licensed then
    if exists(select 1 from public.print_devices where active and driver in ('EPOS','BRIDGE')) then
      raise exception 'PRINT_DEVICES_STILL_CONFIGURED';
    end if;
    if exists(select 1 from public.print_jobs j join public.print_devices d on d.id=j.print_device_id
              where d.driver in ('EPOS','BRIDGE') and j.status in ('QUEUED','SENT')) then
      raise exception 'PRINT_JOBS_PENDING';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.external_printing_revocation_guard() from public,anon,authenticated;
create trigger external_printing_revocation before update of licensed on public.feature_flags
for each row execute function private.external_printing_revocation_guard();

commit;
