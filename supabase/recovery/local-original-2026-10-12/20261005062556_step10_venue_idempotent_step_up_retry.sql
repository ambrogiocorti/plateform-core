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

  if p_key is null then raise exception 'INVALID_REQUEST'; end if;

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

  perform private.consume_step_up(p_grant,'FEATURE_CHANGE');

  if not coalesce((select licensed from public.feature_flags where name='MULTI_VENUE'),false) then
    raise exception 'FEATURE_NOT_LICENSED';
  end if;
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

create or replace function public.update_venue(
  p_venue uuid,
  p_version bigint,
  p_values jsonb,
  p_grant uuid,
  p_key uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  current_row public.venues;
  next_name text;
  next_slug text;
  next_code text;
  next_address text;
  next_phone text;
  next_email text;
  next_opening_hours jsonb;
  next_timezone text;
  next_currency text;
  next_locale text;
  next_active boolean;
  next_status text;
  prior jsonb;
  cached jsonb;
  result jsonb;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);

  if p_key is null or p_values is null or jsonb_typeof(p_values)<>'object' or p_values='{}'::jsonb then
    raise exception 'INVALID_REQUEST';
  end if;

  cached:=private.idempotency_begin(
    'update_venue',
    p_key,
    jsonb_build_object('venue',p_venue,'version',p_version,'values',p_values)
  );
  if cached is not null then return cached; end if;

  perform private.consume_step_up(p_grant,'FEATURE_CHANGE');

  if exists(
    select 1 from jsonb_object_keys(p_values) k
    where k not in (
      'name','slug','code','address','phone','email','opening_hours',
      'timezone','currency','locale','active','operational_status'
    )
  ) then
    raise exception 'UNKNOWN_FIELD';
  end if;

  select * into current_row from public.venues where id=p_venue for update;
  if current_row.id is null then raise exception 'NOT_FOUND'; end if;
  if p_version is distinct from current_row.version then raise exception 'VERSION_CONFLICT'; end if;
  prior:=to_jsonb(current_row);

  next_name:=case when p_values ? 'name' then trim(p_values->>'name') else current_row.name end;
  next_slug:=case when p_values ? 'slug' then trim(p_values->>'slug') else current_row.slug end;
  next_code:=case when p_values ? 'code' then upper(trim(p_values->>'code')) else current_row.code end;
  next_address:=case when p_values ? 'address' then trim(p_values->>'address') else current_row.address end;
  next_phone:=case when p_values ? 'phone' then trim(p_values->>'phone') else current_row.phone end;
  next_email:=case
    when p_values ? 'email' then nullif(lower(trim(coalesce(p_values->>'email',''))),'')
    else current_row.email
  end;
  next_opening_hours:=case when p_values ? 'opening_hours' then p_values->'opening_hours' else current_row.opening_hours end;
  next_timezone:=case when p_values ? 'timezone' then trim(p_values->>'timezone') else current_row.timezone end;
  next_currency:=case when p_values ? 'currency' then upper(trim(p_values->>'currency')) else current_row.currency end;
  next_locale:=case when p_values ? 'locale' then trim(p_values->>'locale') else current_row.locale end;
  next_active:=case when p_values ? 'active' then (p_values->>'active')::boolean else current_row.active end;
  next_status:=case when p_values ? 'operational_status' then upper(trim(p_values->>'operational_status')) else current_row.operational_status end;

  if next_name is null or length(next_name) not between 1 and 160
     or next_slug is null or next_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or next_code is null or next_code !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'
     or next_address is null or length(next_address) not between 3 and 500
     or next_phone is null or length(next_phone) not between 3 and 40
     or (next_email is not null and next_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
     or next_opening_hours is null or jsonb_typeof(next_opening_hours)<>'object'
     or pg_column_size(next_opening_hours)>32768
     or next_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=next_timezone)
     or next_currency !~ '^[A-Z]{3}$'
     or next_locale !~ '^[a-z]{2}(-[A-Z]{2})?$'
     or next_status not in ('OPEN','CLOSED','MAINTENANCE') then
    raise exception 'INVALID_VENUE';
  end if;

  if current_row.active and not next_active
     and (select count(*) from public.venues where active)=1 then
    raise exception 'FIRST_VENUE_REQUIRED';
  end if;
  if not current_row.active and next_active
     and exists(select 1 from public.venues where active)
     and not coalesce((select licensed from public.feature_flags where name='MULTI_VENUE'),false) then
    raise exception 'MULTI_VENUE_DISABLED';
  end if;

  update public.venues
     set name=next_name,
         slug=next_slug,
         code=next_code,
         address=next_address,
         phone=next_phone,
         email=next_email,
         opening_hours=next_opening_hours,
         timezone=next_timezone,
         currency=next_currency,
         locale=next_locale,
         active=next_active,
         operational_status=next_status
   where id=current_row.id
   returning to_jsonb(public.venues.*) into result;

  perform private.audit(
    case
      when current_row.active and not next_active then 'VENUE_DEACTIVATED'
      when not current_row.active and next_active then 'VENUE_ACTIVATED'
      else 'VENUE_UPDATED'
    end,
    'venues',
    current_row.id,
    current_row.id,
    prior,
    result
  );

  return private.idempotency_finish(
    'update_venue',
    p_key,
    jsonb_build_object(
      'id',current_row.id,
      'version',(result->>'version')::bigint,
      'active',(result->>'active')::boolean,
      'operational_status',result->>'operational_status'
    )
  );
end $$;
