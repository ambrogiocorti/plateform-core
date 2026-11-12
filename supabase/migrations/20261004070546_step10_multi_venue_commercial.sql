begin;

create or replace function public.create_venue(
  p_name text,
  p_slug text,
  p_code text,
  p_address text,
  p_phone text,
  p_email text,
  p_timezone text,
  p_currency text,
  p_locale text,
  p_grant uuid,
  p_key uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  ref uuid;
  result jsonb;
  normalized_code text:=upper(trim(p_code));
  normalized_currency text:=upper(trim(p_currency));
  normalized_email text:=nullif(lower(trim(coalesce(p_email,''))), '');
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  perform private.consume_step_up(p_grant,'FEATURE_CHANGE');

  if not coalesce((select licensed from public.feature_flags where name='MULTI_VENUE'),false) then
    raise exception 'FEATURE_NOT_LICENSED';
  end if;

  if p_key is null then raise exception 'INVALID_REQUEST'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 160
     or p_slug is null or trim(p_slug) !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'
     or p_address is null or length(trim(p_address)) not between 3 and 500
     or p_phone is null or length(trim(p_phone)) not between 3 and 40
     or normalized_currency !~ '^[A-Z]{3}$'
     or p_locale is null or trim(p_locale) !~ '^[a-z]{2}(-[A-Z]{2})?$'
     or p_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone)
     or (normalized_email is not null and normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'INVALID_VENUE';
  end if;

  result:=private.idempotency_begin(
    'create_venue',
    p_key,
    jsonb_build_object(
      'name',trim(p_name),'slug',trim(p_slug),'code',normalized_code,
      'address',trim(p_address),'phone',trim(p_phone),'email',normalized_email,
      'timezone',p_timezone,'currency',normalized_currency,'locale',trim(p_locale)
    )
  );
  if result is not null then return result; end if;

  perform pg_advisory_xact_lock(71467002);
  perform 1 from public.restaurant_profile where id for update;
  perform 1 from public.system_limits where id for update;

  if (select count(*) from public.venues where active)>=(select max_venues from public.system_limits where id) then
    raise exception 'VENUE_LIMIT';
  end if;

  insert into public.venues(name,slug,code,address,phone,email,timezone,currency,locale,active,operational_status)
  values(
    trim(p_name),trim(p_slug),normalized_code,trim(p_address),trim(p_phone),normalized_email,
    p_timezone,normalized_currency,trim(p_locale),true,'OPEN'
  ) returning id into ref;

  insert into public.venue_settings(venue_id) values(ref);

  perform private.audit(
    'VENUE_CREATED','venues',ref,ref,null,
    jsonb_build_object('name',trim(p_name),'slug',trim(p_slug),'code',normalized_code)
  );

  return private.idempotency_finish(
    'create_venue',p_key,jsonb_build_object('id',ref,'version',1)
  );
end $$;

revoke all on function public.create_venue(text,text,text,text,text,text,text,text,text,uuid,uuid) from public,anon;
grant execute on function public.create_venue(text,text,text,text,text,text,text,text,text,uuid,uuid) to authenticated;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.create_venue(text,text,text,text,text,text,text,text,text,uuid,uuid)','authenticated')
on conflict do nothing;

commit;