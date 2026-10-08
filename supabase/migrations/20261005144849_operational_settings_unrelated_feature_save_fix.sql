create or replace function public.configure_venue_operations(p_venue uuid, p_values jsonb)
returns void
language plpgsql
security definer
set search_path=''
as $function$
declare
  k text;
  config public.venue_settings;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if jsonb_typeof(p_values)<>'object'
     or exists(
       select 1
       from jsonb_object_keys(p_values) x
       where x not in (
         'reservations_enabled',
         'customer_ordering',
         'customer_bill_request',
         'returns_enabled',
         'step_starter_roles',
         'delivery_routing',
         'sounds'
       )
     )
  then
    raise exception 'INVALID_SETTINGS';
  end if;

  select *
  into config
  from public.venue_settings
  where venue_id=p_venue
  for update;

  if p_values ? 'customer_ordering'
     and p_values->>'customer_ordering'<>'DISABLED'
     and (p_values->>'customer_ordering') is distinct from config.customer_ordering::text
     and not exists(
       select 1
       from public.feature_flags
       where name='CLIENT_ORDERING'
         and licensed
     )
  then
    raise exception 'FEATURE_NOT_LICENSED';
  end if;

  for k in select jsonb_object_keys(p_values) loop
    execute format(
      'update public.venue_settings s set %I=r.%I from jsonb_populate_record(null::public.venue_settings,$1) r where s.venue_id=$2',
      k,k
    )
    using p_values,p_venue;
  end loop;
end
$function$;
