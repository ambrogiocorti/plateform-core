
create or replace function public.get_staff_venue_context()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_actor uuid:=private.effective_user_id();
  v_role public.user_role:=private.current_role();
  v_scope public.user_scope;
  v_multi boolean;
  v_session private.staff_sessions;
  v_current uuid;
  v_selected uuid;
  v_count integer;
  v_active_count integer;
  v_venues jsonb;
begin
  if v_actor is null or v_role is null then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  select scope
  into v_scope
  from public.staff_profiles
  where id=v_actor
    and active;

  if v_scope is null then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  select coalesce(licensed,false)
  into v_multi
  from public.feature_flags
  where name='MULTI_VENUE';

  select *
  into v_session
  from private.staff_sessions
  where session_id=private.jwt_session_id()
    and user_id=v_actor
    and revoked_at is null
    and unlocked_until>clock_timestamp();

  if v_session.session_id is null then
    raise exception 'PIN_OR_FULL_AUTH_REQUIRED' using errcode='42501';
  end if;

  if v_session.device_id is not null then
    select venue_id
    into v_current
    from public.registered_devices
    where id=v_session.device_id
      and user_id=v_actor
      and revoked_at is null;
  end if;

  select count(*)::integer
  into v_active_count
  from public.venues
  where active;

  if not v_multi and v_active_count<>1 then
    raise exception 'MONO_VENUE_INVARIANT_BROKEN';
  end if;

  with allowed as (
    select v.id,v.name,v.slug,v.code
    from public.venues v
    where v.active
      and (
        v_role='SUPER_ADMIN'
        or v_scope='CHAIN'
        or exists(
          select 1
          from public.staff_venue_assignments a
          where a.user_id=v_actor
            and a.venue_id=v.id
            and a.active
        )
      )
  )
  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',id,
          'name',name,
          'slug',slug,
          'code',code
        )
        order by name,id
      ),
      '[]'::jsonb
    )
  into v_count,v_venues
  from allowed;

  if v_count=0 then
    raise exception 'VENUE_ASSIGNMENT_REQUIRED' using errcode='42501';
  end if;

  if v_current is not null
     and exists(
       select 1
       from jsonb_array_elements(v_venues) x
       where (x->>'id')::uuid=v_current
     )
  then
    v_selected:=v_current;
  else
    select (x->>'id')::uuid
    into v_selected
    from jsonb_array_elements(v_venues) x
    order by x->>'name',(x->>'id')::uuid
    limit 1;
  end if;

  return jsonb_build_object(
    'multi_venue',v_multi,
    'show_selector',v_multi and v_count>1,
    'auto_open',not (v_multi and v_count>1),
    'current_venue_id',v_selected,
    'authorized_venue_count',v_count,
    'venues',v_venues
  );
end
$$;

revoke all on function public.get_staff_venue_context()
from public,anon;
grant execute on function public.get_staff_venue_context()
to authenticated,service_role;

create or replace function public.set_operational_venue(
  p_venue uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=private.effective_user_id();
  v_role public.user_role:=private.current_role();
  v_session private.staff_sessions;
begin
  if p_venue is null
     or v_actor is null
     or v_role is null
  then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  if not private.has_venue(p_venue) then
    raise exception 'VENUE_FORBIDDEN' using errcode='42501';
  end if;

  select *
  into v_session
  from private.staff_sessions
  where session_id=private.jwt_session_id()
    and user_id=v_actor
    and revoked_at is null
    and unlocked_until>clock_timestamp()
  for update;

  if v_session.session_id is null then
    raise exception 'PIN_OR_FULL_AUTH_REQUIRED' using errcode='42501';
  end if;

  if v_session.device_id is null then
    if v_role<>'SUPER_ADMIN' then
      raise exception 'DEVICE_REQUIRED';
    end if;
  else
    update public.registered_devices
    set venue_id=p_venue,
        last_seen_at=clock_timestamp()
    where id=v_session.device_id
      and user_id=v_actor
      and revoked_at is null;

    if not found then
      raise exception 'DEVICE_REVOKED' using errcode='42501';
    end if;
  end if;

  return public.get_staff_venue_context();
end
$$;

revoke all on function public.set_operational_venue(uuid)
from public,anon;
grant execute on function public.set_operational_venue(uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values
  ('public.get_staff_venue_context()','authenticated'),
  ('public.set_operational_venue(uuid)','authenticated')
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values
  (
    'VENUE_CONTEXT_MONO_E2E',
    'E2E',
    true,
    'With MULTI_VENUE disabled and exactly one active venue, staff venue context auto-opens the sole authorized venue and never shows a selector.'
  ),
  (
    'VENUE_CONTEXT_SINGLE_ASSIGNMENT_E2E',
    'E2E',
    true,
    'With MULTI_VENUE enabled, a VENUE-scoped user assigned to exactly one active venue auto-opens it without a selector.'
  ),
  (
    'VENUE_CONTEXT_MULTI_ASSIGNMENT_E2E',
    'E2E',
    true,
    'With MULTI_VENUE enabled, a user assigned to multiple active venues sees a selector, can persist an authorized operational venue and cannot select a venue after authorization is removed.'
  )
on conflict(key) do nothing;
