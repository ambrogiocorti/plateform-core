create table if not exists public.waitlist_entries(
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id),
  service_id uuid not null references public.services(id),
  service_date date not null,
  preferred_start_time time not null,
  preferred_end_time time,
  party_size integer not null check(party_size between 1 and 1000),
  customer_name text not null check(length(trim(customer_name)) between 1 and 160),
  customer_phone text not null check(customer_phone ~ E'^\\+[0-9]{7,15}$'),
  notes text check(notes is null or length(notes)<=2000),
  status text not null default 'WAITING'
    check(status in ('WAITING','OFFERED','CONFIRMED','EXPIRED','CANCELLED','CONVERTED_TO_RESERVATION')),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  confirmed_at timestamptz,
  converted_reservation_id uuid references public.reservations(id),
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(offer_expires_at is null or offered_at is not null),
  check(offer_expires_at is null or offer_expires_at>offered_at),
  check(status<>'OFFERED' or (offered_at is not null and offer_expires_at is not null)),
  check(status not in ('CONFIRMED','CONVERTED_TO_RESERVATION') or confirmed_at is not null),
  check((status='CONVERTED_TO_RESERVATION')=(converted_reservation_id is not null))
);

alter table public.waitlist_entries enable row level security;
revoke all on table public.waitlist_entries from anon,authenticated;
grant select on table public.waitlist_entries to authenticated;

create policy waitlist_staff_read
on public.waitlist_entries
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN','HOST']::public.user_role[])
  and private.has_venue(venue_id)
);

create index if not exists waitlist_entries_service_date_idx
on public.waitlist_entries(venue_id,service_id,service_date,status,created_at,id);

create index if not exists waitlist_entries_offer_expiry_idx
on public.waitlist_entries(offer_expires_at,id)
where status='OFFERED';

create index if not exists waitlist_entries_converted_reservation_idx
on public.waitlist_entries(converted_reservation_id)
where converted_reservation_id is not null;

create or replace function private.waitlist_time_distance_minutes(
  p_start time,
  p_end time,
  p_target time
)
returns integer
language plpgsql
immutable
set search_path=''
as $$
declare
  s integer;
  e integer;
  t integer;
  d1 integer;
  d2 integer;
begin
  if p_start is null or p_target is null then return null; end if;
  s:=extract(epoch from p_start)::integer/60;
  t:=extract(epoch from p_target)::integer/60;

  if p_end is null then
    return least(abs(t-s),1440-abs(t-s));
  end if;

  e:=extract(epoch from p_end)::integer/60;

  if s=e then return 0; end if;

  if s<e then
    if t>=s and t<=e then return 0; end if;
  else
    if t>=s or t<=e then return 0; end if;
  end if;

  d1:=least(abs(t-s),1440-abs(t-s));
  d2:=least(abs(t-e),1440-abs(t-e));
  return least(d1,d2);
end
$$;

revoke all on function private.waitlist_time_distance_minutes(time,time,time)
from public,anon,authenticated;

create or replace function private.guard_waitlist_entry()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if tg_op='DELETE' then raise exception 'IMMUTABLE_WAITLIST_ENTRY'; end if;

  if (
    to_jsonb(new)-array[
      'status','offered_at','offer_expires_at','confirmed_at',
      'converted_reservation_id','version','updated_at','notes'
    ]
  ) is distinct from (
    to_jsonb(old)-array[
      'status','offered_at','offer_expires_at','confirmed_at',
      'converted_reservation_id','version','updated_at','notes'
    ]
  ) then
    raise exception 'IMMUTABLE_WAITLIST_ENTRY';
  end if;

  if old.status='WAITING' and new.status not in ('WAITING','OFFERED','CANCELLED') then
    raise exception 'INVALID_WAITLIST_TRANSITION';
  elsif old.status='OFFERED' and new.status not in ('OFFERED','CONFIRMED','EXPIRED','CANCELLED') then
    raise exception 'INVALID_WAITLIST_TRANSITION';
  elsif old.status='CONFIRMED' and new.status not in ('CONFIRMED','CONVERTED_TO_RESERVATION','EXPIRED','CANCELLED') then
    raise exception 'INVALID_WAITLIST_TRANSITION';
  elsif old.status in ('EXPIRED','CANCELLED','CONVERTED_TO_RESERVATION') and new.status<>old.status then
    raise exception 'WAITLIST_TERMINAL';
  end if;

  return new;
end
$$;

create trigger waitlist_entry_guard
before update or delete on public.waitlist_entries
for each row execute function private.guard_waitlist_entry();

create trigger touch_version
before update on public.waitlist_entries
for each row execute function private.touch_version();

create trigger audit_mutation
after insert or update on public.waitlist_entries
for each row execute function private.audit_row();