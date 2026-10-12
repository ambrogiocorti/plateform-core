begin;
create function private.room_editable(p_room uuid) returns void language plpgsql security definer set search_path='' as $$

begin
  if not exists(select 1 from public.rooms where id=p_room) then raise exception 'NOT_FOUND'; end if;
  if exists(select 1 from public.tables t where t.room_id=p_room and
    (t.technical_status not in ('AVAILABLE','TO_RESET') or exists(select 1 from public.accounts a where a.table_id=t.id and a.floor_released_at is null)
      or exists(select 1 from public.reservations r where r.table_id=t.id and r.status in ('ARRIVED','SEATED'))
      or exists(select 1 from public.table_merges m where (m.primary_table_id=t.id or m.secondary_table_id=t.id) and m.split_at is null))) then raise exception 'LAYOUT_IN_SERVICE'; end if;
end $$;

-- Every configuration entry point follows the editor service lock, including generic forms.
alter function public.save_configuration(text,uuid,uuid,jsonb,bigint) rename to save_configuration_unchecked;
alter function public.save_configuration_unchecked(text,uuid,uuid,jsonb,bigint) set schema private;
revoke all on function private.save_configuration_unchecked(text,uuid,uuid,jsonb,bigint) from public,anon,authenticated;
create function public.save_configuration(p_entity text,p_venue uuid,p_id uuid,p_values jsonb,p_version bigint default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare resource_venue uuid; room_ref uuid; old_room uuid; previous public.room_layouts;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if p_entity in ('rooms','room_layouts','zones','tables') then
    if p_id is not null then
      execute format('select venue_id from public.%I where id=$1',p_entity) into resource_venue using p_id;
      if resource_venue is null then raise exception 'NOT_FOUND';end if;
      if resource_venue is distinct from p_venue then raise exception 'VENUE_FORBIDDEN';end if;
    end if;
    perform private.lock_floor(p_venue);
    if p_entity='rooms' then room_ref:=p_id;
    else
      room_ref:=(p_values->>'room_id')::uuid;
      if p_id is not null then execute format('select room_id from public.%I where id=$1 and venue_id=$2',p_entity) into old_room using p_id,p_venue; end if;
    end if;
    room_ref:=coalesce(room_ref,old_room);
    if old_room is not null and old_room is distinct from room_ref then
      perform 1 from public.rooms where id=old_room and venue_id=p_venue for update;
      perform private.room_editable(old_room);
    end if;
    if room_ref is not null then
      perform 1 from public.rooms where id=room_ref and venue_id=p_venue for update;
      if not found then raise exception 'INVALID_ROOM'; end if;
      perform private.room_editable(room_ref);
    end if;
    if p_entity='room_layouts' then
      select * into previous from public.room_layouts where id=p_id;
      if p_values ? 'elements' or (p_values ? 'active' and (p_values->>'active')::boolean is distinct from coalesce(previous.active,false)) then raise exception 'USE_ROOM_EDITOR'; end if;
    end if;
  elsif p_entity in ('shifts','booking_time_slots','reservation_form_definitions','reservation_form_fields','variant_groups','variant_options') then
    raise exception 'USE_STRUCTURED_EDITOR';
  end if;
  return private.save_configuration_unchecked(p_entity,p_venue,p_id,p_values,p_version);
end $$;
grant execute on function public.save_configuration(text,uuid,uuid,jsonb,bigint) to authenticated;
-- Capture delivery attempts before a returned dish reopens its step.
create table public.step_delivery_history (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), step_id uuid not null references public.order_steps(id),
  waiter_id uuid not null references public.staff_profiles(id), claimed_at timestamptz not null, served_at timestamptz, archived_at timestamptz not null default now()
);
alter table public.step_delivery_history enable row level security;
revoke all on public.step_delivery_history from public,anon,authenticated;
grant select on public.step_delivery_history to authenticated;
create policy history_read on public.step_delivery_history for select to authenticated using(private.has_venue(venue_id) and private.is_role(array['ADMIN','PASS']::public.user_role[]));
create trigger immutable_history before update or delete on public.step_delivery_history for each row execute function private.immutable_record();
create trigger immutable_history_truncate before truncate on public.step_delivery_history for each statement execute function private.immutable_record();
create function private.archive_delivery() returns trigger language plpgsql security definer set search_path='' as $$
begin insert into public.step_delivery_history(venue_id,step_id,waiter_id,claimed_at,served_at) values(old.venue_id,old.step_id,old.waiter_id,old.claimed_at,old.served_at);return old;end $$;
create trigger delivery_archive before delete on public.step_deliveries for each row execute function private.archive_delivery();
commit;
