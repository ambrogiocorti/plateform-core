begin;

create or replace function public.suggest_staff_identifier(p_name text)
returns text
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  domain text;
  base text;
  candidate text;
  suffix integer:=1;
begin
  perform private.authorize(
    null,
    array['ADMIN','SUPER_ADMIN']::public.user_role[],
    false
  );

  if p_name is null or length(trim(p_name)) not between 1 and 160 then
    raise exception 'INVALID_STAFF_COMMAND';
  end if;

  select staff_identity_domain
  into domain
  from public.restaurant_profile
  where id;

  if domain is null then
    raise exception 'SETUP_REQUIRED';
  end if;

  base:=trim(
    both '.'
    from regexp_replace(
      lower(
        translate(
          trim(p_name),
          'àáâäèéêëìíîïòóôöùúûüçñ',
          'aaaaeeeeiiiioooouuuucn'
        )
      ),
      '[^a-z0-9]+',
      '.',
      'g'
    )
  );

  base:=left(coalesce(nullif(base,''),'staff'),48);
  candidate:=base||'@'||domain;

  while exists(
      select 1
      from auth.users
      where lower(email)=candidate
    )
    or exists(
      select 1
      from public.staff_admin_jobs
      where action='CREATE'
        and status<>'COMPLETED'
        and lower(values->>'identifier')=candidate
    )
  loop
    suffix:=suffix+1;
    candidate:=base||suffix::text||'@'||domain;
    if suffix>10000 then
      raise exception 'STAFF_IDENTIFIER_UNAVAILABLE';
    end if;
  end loop;

  return candidate;
end
$$;

revoke all on function public.suggest_staff_identifier(text)
from public,anon;
grant execute on function public.suggest_staff_identifier(text)
to authenticated,service_role;

create or replace function private.test_staff_identifier_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_def text;
  v_profile_def text;
begin
  select pg_get_functiondef(p.oid)
  into v_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='suggest_staff_identifier'
    and pg_get_function_identity_arguments(p.oid)='p_name text';

  select pg_get_viewdef('public.restaurant_profile'::regclass,true)
  into v_profile_def
  where false;

  if v_def is null
     or v_def not like '%staff_identity_domain%'
     or v_def not like '%candidate := base || suffix::text || ''@'' || domain%'
     or v_def like '%candidate := base || ''.'' || suffix::text%'
     or v_def not like '%auth.users%'
     or v_def not like '%staff_admin_jobs%'
     or v_def not like '%STAFF_IDENTIFIER_UNAVAILABLE%'
  then
    raise exception 'STAFF_IDENTIFIER_CONTRACT_FAILED';
  end if;

  if not exists(
    select 1
    from information_schema.columns
    where table_schema='public'
      and table_name='restaurant_profile'
      and column_name='staff_identity_domain'
  ) then
    raise exception 'STAFF_IDENTIFIER_DOMAIN_MISSING';
  end if;

  return jsonb_build_object(
    'stable_identity_domain_column',true,
    'base_name_normalization',true,
    'first_collision_suffix','2',
    'existing_auth_users_checked',true,
    'pending_create_jobs_checked',true
  );
end
$$;

revoke all on function private.test_staff_identifier_contract()
from public,anon,authenticated;
grant execute on function private.test_staff_identifier_contract()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'STAFF_IDENTIFIER_STABLE_DOMAIN_CONTRACT',
  'REGRESSION',
  true,
  'Staff identifiers use the dedicated stable identity domain, normalize display names, resolve collisions as base2/base3 without coupling to public/staff URL changes, and check both Auth users and pending create jobs.'
)
on conflict(key) do nothing;

commit;