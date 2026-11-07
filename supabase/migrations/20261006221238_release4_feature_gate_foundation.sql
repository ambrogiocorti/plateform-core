
alter table public.feature_flags
  drop constraint if exists feature_flags_name_check;

alter table public.feature_flags
  add constraint feature_flags_name_check
  check(name = any(array[
    'MULTI_VENUE',
    'CLIENT_ORDERING',
    'STRIPE',
    'SATISPAY_API',
    'OFFLINE',
    'ADVANCED_ROOM_EDITOR',
    'ADVANCED_ANALYTICS',
    'RESERVATION_MESSAGING',
    'WHATSAPP_TELEGRAM_SMS_MESSAGING',
    'BOOKING_DEPOSITS',
    'WAITLIST',
    'TAKEAWAY',
    'FOOD_COST',
    'MENU_PROMOTIONS',
    'MULTI_MENU_QR'
  ]::text[]));

insert into public.feature_flags(name,licensed)
values
  ('RESERVATION_MESSAGING',false),
  ('WHATSAPP_TELEGRAM_SMS_MESSAGING',false),
  ('BOOKING_DEPOSITS',false),
  ('WAITLIST',false),
  ('TAKEAWAY',false),
  ('FOOD_COST',false),
  ('MENU_PROMOTIONS',false),
  ('MULTI_MENU_QR',false)
on conflict(name) do nothing;

create table if not exists public.venue_features(
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null references public.feature_flags(name),
  enabled boolean not null default false,
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  primary key(venue_id,name)
);

alter table public.venue_features enable row level security;
revoke all on table public.venue_features from anon,authenticated;
grant select on table public.venue_features to authenticated;

drop policy if exists venue_features_admin_read on public.venue_features;
create policy venue_features_admin_read
on public.venue_features
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN']::public.user_role[])
  and private.has_venue(venue_id)
);

create index if not exists venue_features_name_idx
on public.venue_features(name,enabled,venue_id);

drop trigger if exists touch_version on public.venue_features;
create trigger touch_version
before update on public.venue_features
for each row execute function private.touch_version();

drop trigger if exists audit_mutation on public.venue_features;
create trigger audit_mutation
after insert or update or delete on public.venue_features
for each row execute function private.audit_row();

create or replace function private.feature_licensed(p_name text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select coalesce((
    select licensed
    from public.feature_flags
    where name=p_name
  ),false)
$$;

revoke all on function private.feature_licensed(text)
from public,anon,authenticated;

create or replace function private.venue_feature_enabled(
  p_venue uuid,
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select
    private.feature_licensed(p_name)
    and coalesce((
      select vf.enabled
      from public.venue_features vf
      where vf.venue_id=p_venue
        and vf.name=p_name
    ),false)
$$;

revoke all on function private.venue_feature_enabled(uuid,text)
from public,anon,authenticated;

create or replace function private.require_venue_feature(
  p_venue uuid,
  p_name text
)
returns void
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not private.feature_licensed(p_name) then
    raise exception 'FEATURE_NOT_LICENSED';
  end if;

  if not private.venue_feature_enabled(p_venue,p_name) then
    raise exception 'FEATURE_DISABLED';
  end if;
end
$$;

revoke all on function private.require_venue_feature(uuid,text)
from public,anon,authenticated;

create or replace function public.save_venue_feature(
  p_venue uuid,
  p_name text,
  p_enabled boolean,
  p_version bigint,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_result jsonb;
  v_row public.venue_features;
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if p_key is null
     or p_venue is null
     or p_name is null
     or p_enabled is null
     or not exists(select 1 from public.feature_flags where name=p_name)
  then
    raise exception 'INVALID_VENUE_FEATURE';
  end if;

  if p_enabled and not private.feature_licensed(p_name) then
    raise exception 'FEATURE_NOT_LICENSED';
  end if;

  v_result:=private.idempotency_begin(
    'venue_feature',
    p_key,
    jsonb_build_object(
      'venue',p_venue,
      'name',p_name,
      'enabled',p_enabled,
      'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  select * into v_row
  from public.venue_features
  where venue_id=p_venue and name=p_name
  for update;

  if v_row.venue_id is null then
    if p_version is not null then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    insert into public.venue_features(venue_id,name,enabled)
    values(p_venue,p_name,p_enabled)
    returning * into v_row;
  else
    if p_version is null or v_row.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    update public.venue_features
    set enabled=p_enabled
    where venue_id=p_venue and name=p_name
    returning * into v_row;
  end if;

  v_result:=jsonb_build_object(
    'venue_id',v_row.venue_id,
    'name',v_row.name,
    'enabled',v_row.enabled,
    'version',v_row.version
  );

  return private.idempotency_finish('venue_feature',p_key,v_result);
end
$$;

revoke all on function public.save_venue_feature(uuid,text,boolean,bigint,uuid)
from public,anon;
grant execute on function public.save_venue_feature(uuid,text,boolean,bigint,uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.save_venue_feature(uuid,text,boolean,bigint,uuid)','authenticated')
on conflict do nothing;
