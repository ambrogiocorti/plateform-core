-- Eseguire esclusivamente in plateform-production, SQL Editor.
-- Funzioni collaudate nella PR #62. Nessun dato o utente viene eliminato.
-- Ripristina anche i tre interruttori e la licenza richiesti dall’utente.
-- Reversible configuration uses the authenticated role and current device session.
-- Privileged staff, credentials, restore and destructive operations keep step-up.
begin;
DO $plateform_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261107152151') THEN
    RAISE EXCEPTION 'Aggiornamento già applicato: non eseguire di nuovo questo script.';
  END IF;
  IF (SELECT count(*) FROM public.venues WHERE active) <> 1 THEN
    RAISE EXCEPTION 'Questo script è preparato per l’installazione Plateform con una sola sede attiva.';
  END IF;
END
$plateform_guard$;
CREATE OR REPLACE FUNCTION public.configure_feature(p_name text, p_licensed boolean, p_step_up uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_licensed is null then raise exception 'INVALID_SETTINGS'; end if;
  perform 1 from public.restaurant_profile where id for update;
  update public.feature_flags set licensed=p_licensed where name=p_name;
  if not found then raise exception 'UNKNOWN_FEATURE'; end if;
end $function$;

CREATE OR REPLACE FUNCTION private.begin_staff_admin_job_step0(p_action text, p_values jsonb, p_key uuid, p_grant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare job public.staff_admin_jobs; target uuid; v uuid; requested_role public.user_role; requested_scope public.user_scope; venues uuid[];
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,0));
  select * into job from public.staff_admin_jobs where actor_id=auth.uid() and idempotency_key=p_key;
  if job.id is not null then if job.action is distinct from p_action or job.values is distinct from p_values then raise exception 'IDEMPOTENCY_MISMATCH';end if;return jsonb_build_object('id',job.id,'user_id',job.target_user_id,'status',job.status);end if;
  if p_key is null or p_values is null or jsonb_typeof(p_values)<>'object' then raise exception 'INVALID_STAFF_COMMAND';end if;
  if p_action='CREATE' then
    if not p_values ?& array['display_name','identifier','role','scope','venue_ids'] or p_values-array['display_name','identifier','role','scope','venue_ids']<>'{}' or length(trim(p_values->>'display_name')) not between 1 and 160 or p_values->>'identifier' !~ '^[^@[:space:]]+@[^@[:space:]]+$'
      then raise exception 'INVALID_STAFF_COMMAND';end if;
    requested_role:=(p_values->>'role')::public.user_role;requested_scope:=(p_values->>'scope')::public.user_scope;
    if requested_role is null or requested_scope is null or requested_role in ('SUPER_ADMIN','SYSTEM','CUSTOMER') then raise exception 'ROLE_NOT_PROVISIONABLE';end if;
    if requested_role='ADMIN' then perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);perform private.consume_step_up(p_grant,'PRIVILEGED_STAFF');
    end if;
    if private.current_role()='ADMIN' and requested_scope='CHAIN' and private.current_scope()<>'CHAIN' then raise exception 'SCOPE_ESCALATION';end if;
    select array_agg(x::uuid) into venues from jsonb_array_elements_text(p_values->'venue_ids') x;
    if requested_scope='VENUE' and coalesce(cardinality(venues),0)=0 then raise exception 'VENUE_ASSIGNMENT_REQUIRED';end if;
    foreach v in array coalesce(venues,'{}') loop if not exists(select 1 from public.venues where id=v and active) or (private.current_role()<>'SUPER_ADMIN' and not private.has_venue(v)) then raise exception 'VENUE_FORBIDDEN';end if;end loop;
    perform 1 from public.system_limits where id for update;
    if (select count(*) from public.staff_profiles where active)+(select count(*) from public.staff_admin_jobs where action='CREATE' and status<>'COMPLETED')>=(select max_users from public.system_limits where id) then raise exception 'STAFF_LIMIT';end if;
    target:=gen_random_uuid();
  elsif p_action in ('RESET_PASSWORD','RESET_MFA','DISABLE') then
    if not p_values ?& array['user_id','reason','identity_verified'] or p_values-array['user_id','reason','identity_verified']<>'{}' or (p_values->>'identity_verified')::boolean is distinct from true or length(trim(p_values->>'reason')) not between 8 and 2000 then raise exception 'IDENTITY_VERIFICATION_REQUIRED';end if;
    target:=(p_values->>'user_id')::uuid;
    if exists(select 1 from public.staff_admin_jobs where target_user_id=target and status<>'COMPLETED') then raise exception 'STAFF_COMMAND_PENDING';end if;
    perform public.revoke_staff_for_reset(target,p_grant,p_action='DISABLE');
    -- Fail closed until both Auth and PostgreSQL complete the authorized recovery.
    update public.staff_profiles set active=false where id=target;
  else raise exception 'INVALID_STAFF_COMMAND';end if;
  insert into public.staff_admin_jobs(actor_id,idempotency_key,target_user_id,action,values) values(auth.uid(),p_key,target,p_action,p_values) returning * into job;
  perform private.audit('STAFF_COMMAND_AUTHORIZED','staff_admin_jobs',job.id,null,null,jsonb_build_object('status',job.status));
  return jsonb_build_object('id',job.id,'user_id',target,'status',job.status);
end $function$;

create or replace function private.can_work_station(p_venue uuid,p_station uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.has_venue(p_venue)
    and private.current_role() in ('KITCHEN_ADMIN','KITCHEN_STAFF')
    and exists(select 1 from public.stations s where s.id=p_station and s.venue_id=p_venue and s.active)
$$;
CREATE OR REPLACE FUNCTION public.get_kitchen_board(p_venue uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.authorize(
    p_venue,
    array['ADMIN','KITCHEN_ADMIN','KITCHEN_STAFF','PASS','WAITER']::public.user_role[],
    false
  );

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',i.id,
        'order_id',o.id,
        'step_id',s.id,
        'step_number',s.step_number,
        'step_status',s.status,
        'order_source',o.origin,
        'table_name',t.name,
        'table_number',t.number,
        'pickup_at',tw.pickup_at,
        'service_label',case
          when o.origin='TAKEAWAY' and tw.pickup_at is not null
            then 'TAKEAWAY — ritiro '||to_char(tw.pickup_at at time zone v.timezone,'HH24:MI')
          when t.id is not null
            then coalesce(t.name,'Tavolo '||t.number::text)
          else null
        end,
        'dish_name',i.dish_name,
        'category_id',d.category_id,
        'category_name',c.name,
        'station_name',st.name,
        'quantity',i.quantity,
        'status',i.status,
        'station_id',i.station_id,
        'version',i.version,
        'created_at',o.created_at,
        'started_at',i.started_at,
        'can_prepare',private.can_work_station(p_venue,i.station_id),
        'can_deliver',
          o.origin<>'TAKEAWAY'
          and private.current_role()='WAITER'
          and t.id is not null
          and (
            private.responsible_waiter(t.id)=private.effective_user_id()
            or exists(
              select 1
              from public.table_assignments ta_runner
              where ta_runner.venue_id=p_venue
                and ta_runner.waiter_id=private.effective_user_id()
                and ta_runner.mode='RUNNER'
                and ta_runner.active
            )
          ),
        'removed_ingredients',
          coalesce((
            select jsonb_agg(ingredient_name order by ingredient_name)
            from public.order_item_removed_ingredients
            where order_item_id=i.id
          ),'[]'::jsonb),
        'variants',
          coalesce((
            select jsonb_agg(
              jsonb_build_object('group',group_name,'option',option_name)
              order by group_name,option_name
            )
            from public.order_item_variants
            where order_item_id=i.id
          ),'[]'::jsonb),
        'allergens',coalesce(i.allergen_snapshot,'[]'::jsonb)
      )
      order by coalesce(tw.pickup_at,o.created_at),o.created_at,s.step_number,i.dish_name
    )
    from public.order_items i
    left join public.dishes d on d.id=i.dish_id
    left join public.categories c on c.id=d.category_id
    left join public.stations st on st.id=i.station_id
    join public.orders o on o.id=i.order_id
    join public.order_steps s on s.id=i.step_id
    join public.accounts a on a.id=o.account_id
    join public.venues v on v.id=o.venue_id
    left join public.tables t on t.id=a.table_id
    left join public.takeaway_orders tw on tw.order_id=o.id
    where i.venue_id=p_venue
      and i.status not in ('SERVED','CANCELLED')
      and a.floor_released_at is null
      and (
        private.is_role(array['ADMIN','KITCHEN_ADMIN','PASS']::public.user_role[])
        or (
          private.current_role()='WAITER'
          and o.origin<>'TAKEAWAY'
          and t.id is not null
          and (
            private.responsible_waiter(t.id)=private.effective_user_id()
            or (
              s.status='READY'
              and exists(
                select 1
                from public.table_assignments ta
                where ta.venue_id=p_venue
                  and ta.waiter_id=private.effective_user_id()
                  and ta.mode='RUNNER'
                  and ta.active
              )
            )
          )
        )
        or private.current_role()='KITCHEN_STAFF'
      )
  ),'[]'::jsonb);
end
$function$;

CREATE OR REPLACE FUNCTION public.configure_system_limits(p_limits jsonb, p_grant uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_limits is null or not p_limits ?& array['max_users','max_venues','max_tables_per_venue','max_dishes','max_devices','max_storage_bytes'] or p_limits-array['max_users','max_venues','max_tables_per_venue','max_dishes','max_devices','max_storage_bytes']<>'{}' then raise exception 'INVALID_LIMITS';end if;
  perform 1 from public.system_limits where id for update;
  if (p_limits->>'max_users')::int<(select count(*) from public.staff_profiles where active) or (p_limits->>'max_venues')::int<(select count(*) from public.venues where active)
    or (p_limits->>'max_tables_per_venue')::int<(select coalesce(max(n),0) from (select count(*) n from public.tables where active group by venue_id) x)
    or (p_limits->>'max_dishes')::int<(select count(*) from public.dishes where active) or (p_limits->>'max_devices')::int<(select count(*) from public.registered_devices where revoked_at is null) then raise exception 'LIMIT_BELOW_CURRENT_USAGE';end if;
  update public.system_limits set max_users=(p_limits->>'max_users')::int,max_venues=(p_limits->>'max_venues')::int,max_tables_per_venue=(p_limits->>'max_tables_per_venue')::int,max_dishes=(p_limits->>'max_dishes')::int,max_devices=(p_limits->>'max_devices')::int,max_storage_bytes=(p_limits->>'max_storage_bytes')::bigint where id;
  perform private.audit('SYSTEM_LIMITS_CHANGED','system_limits',null,null,null,p_limits);
end $function$;

CREATE OR REPLACE FUNCTION public.create_venue(p_name text, p_slug text, p_code text, p_address text, p_phone text, p_email text, p_timezone text, p_currency text, p_locale text, p_grant uuid, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.set_installation_status(p_status installation_status, p_step_up uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_status public.installation_status;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_reason is null or length(trim(p_reason)) not between 8 and 2000 then raise exception 'REASON_REQUIRED';end if;
  select status into current_status from public.restaurant_profile where id for update;
  if not ((current_status='ACTIVE' and p_status='SUSPENDED') or (current_status='SUSPENDED' and p_status='ACTIVE')) or p_status is null then raise exception 'INVALID_TRANSITION';end if;
  
  update public.restaurant_profile set status=p_status where id;
  perform private.audit('INSTALLATION_STATUS_CHANGED','restaurant_profile',null,null,jsonb_build_object('status',current_status),jsonb_build_object('status',p_status,'reason',trim(p_reason)));
end $function$;

CREATE OR REPLACE FUNCTION public.update_staff_access(p_user uuid, p_name text, p_role user_role, p_scope user_scope, p_venues uuid[], p_version bigint, p_reason text, p_grant uuid, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target public.staff_profiles; venue uuid; old_venues uuid[]; requested uuid[]; response jsonb; changed boolean;
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  if private.impersonation_id() is not null or not private.can_manage_staff(p_user) then raise exception 'FORBIDDEN' using errcode='42501';end if;
  if p_name is null or length(trim(p_name)) not between 1 and 160 or p_reason is null or length(trim(p_reason)) not between 8 and 2000
    or p_role is null or p_scope is null or p_venues is null or cardinality(p_venues)>100 or array_position(p_venues,null) is not null then
    raise exception 'INVALID_STAFF_COMMAND';
  end if;
  if (private.current_role()='SUPER_ADMIN' and p_role<>'ADMIN') or (private.current_role()='ADMIN' and p_role in ('ADMIN','SUPER_ADMIN','SYSTEM','CUSTOMER')) then
    raise exception 'ROLE_NOT_PROVISIONABLE';
  end if;
  if p_scope='CHAIN' and private.current_scope()<>'CHAIN' then raise exception 'SCOPE_ESCALATION';end if;
  select coalesce(array_agg(distinct v order by v),'{}') into requested from unnest(p_venues) v;
  if p_scope='VENUE' and cardinality(requested)=0 then raise exception 'VENUE_ASSIGNMENT_REQUIRED';end if;
  foreach venue in array requested loop
    if not exists(select 1 from public.venues where id=venue and active) or not private.has_venue(venue) then raise exception 'VENUE_FORBIDDEN' using errcode='42501';end if;
  end loop;
  response:=private.idempotency_begin('STAFF_ACCESS',p_key,jsonb_build_object('id',p_user,'name',trim(p_name),'role',p_role,'scope',p_scope,'venues',requested,'version',p_version,'reason',trim(p_reason)));
  if response is not null then return response;end if;
  select * into target from public.staff_profiles where id=p_user for update;
  if target.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if exists(select 1 from public.staff_admin_jobs where target_user_id=p_user and status<>'COMPLETED') then raise exception 'STAFF_COMMAND_PENDING';end if;
  if target.role='ADMIN' or p_role='ADMIN' then
    perform private.consume_step_up(p_grant,case when private.current_role()='SUPER_ADMIN' then 'PRIVILEGED_STAFF' else 'STAFF_CHANGE' end,p_user);
  end if;
  select coalesce(array_agg(venue_id order by venue_id),'{}') into old_venues from public.staff_venue_assignments where user_id=p_user and active;
  changed:=target.role<>p_role or target.scope<>p_scope or old_venues<>requested;
  update public.staff_profiles set display_name=trim(p_name),role=p_role,scope=p_scope where id=p_user;
  update public.staff_venue_assignments set active=false where user_id=p_user;
  foreach venue in array requested loop
    insert into public.staff_venue_assignments(user_id,venue_id) values(p_user,venue) on conflict(user_id,venue_id) do update set active=true;
  end loop;
  if changed then
    update public.table_assignments set active=false where waiter_id=p_user and active and (p_role<>'WAITER' or (p_scope='VENUE' and not venue_id=any(requested)));
    update public.station_staff_assignments set active=false where user_id=p_user and active and (p_role<>'KITCHEN_STAFF' or (p_scope='VENUE' and not venue_id=any(requested)));
    update public.cashier_assignments set active=false where user_id=p_user and active and (p_role<>'CASHIER' or (p_scope='VENUE' and not venue_id=any(requested)));
    perform private.invalidate_staff_access(p_user);
    delete from private.staff_pins where user_id=p_user;
  end if;
  insert into private.staff_access_change_reasons(actor_id,target_id,operation_key,reason) values(auth.uid(),p_user,p_key,trim(p_reason));
  foreach venue in array (select coalesce(array_agg(distinct v),'{}') from unnest(old_venues||requested) v) loop
    if (venue=any(old_venues)) is distinct from (venue=any(requested)) then
      perform private.audit('STAFF_VENUE_ACCESS_CHANGED','staff_profiles',p_user,venue,
        jsonb_build_object('active',venue=any(old_venues)),jsonb_build_object('active',venue=any(requested)));
    end if;
  end loop;
  perform private.audit('STAFF_ACCESS_CHANGED','staff_profiles',p_user,null,to_jsonb(target),jsonb_build_object('role',p_role,'scope',p_scope));
  select jsonb_build_object('id',id,'version',version) into response from public.staff_profiles where id=p_user;
  return private.idempotency_finish('STAFF_ACCESS',p_key,response);
end $function$;

CREATE OR REPLACE FUNCTION public.update_venue(p_venue uuid, p_version bigint, p_values jsonb, p_grant uuid, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;


DO $plateform_preferences$
DECLARE target_venue uuid;
BEGIN
  SELECT id INTO STRICT target_venue FROM public.venues WHERE active;
  UPDATE public.venue_settings
     SET reservations_enabled=true, customer_bill_request=true, returns_enabled=true
   WHERE venue_id=target_venue;
  UPDATE public.feature_flags SET licensed=true WHERE name='RESERVATION_MESSAGING';
END
$plateform_preferences$;

INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
VALUES ('20261107152151','flexible_kitchen_and_routine_settings',ARRAY[$plateform_source_62$-- Reversible configuration uses the authenticated role and current device session.
-- Privileged staff, credentials, restore and destructive operations keep step-up.
begin;
CREATE OR REPLACE FUNCTION public.configure_feature(p_name text, p_licensed boolean, p_step_up uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_licensed is null then raise exception 'INVALID_SETTINGS'; end if;
  perform 1 from public.restaurant_profile where id for update;
  update public.feature_flags set licensed=p_licensed where name=p_name;
  if not found then raise exception 'UNKNOWN_FEATURE'; end if;
end $function$;

CREATE OR REPLACE FUNCTION private.begin_staff_admin_job_step0(p_action text, p_values jsonb, p_key uuid, p_grant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare job public.staff_admin_jobs; target uuid; v uuid; requested_role public.user_role; requested_scope public.user_scope; venues uuid[];
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,0));
  select * into job from public.staff_admin_jobs where actor_id=auth.uid() and idempotency_key=p_key;
  if job.id is not null then if job.action is distinct from p_action or job.values is distinct from p_values then raise exception 'IDEMPOTENCY_MISMATCH';end if;return jsonb_build_object('id',job.id,'user_id',job.target_user_id,'status',job.status);end if;
  if p_key is null or p_values is null or jsonb_typeof(p_values)<>'object' then raise exception 'INVALID_STAFF_COMMAND';end if;
  if p_action='CREATE' then
    if not p_values ?& array['display_name','identifier','role','scope','venue_ids'] or p_values-array['display_name','identifier','role','scope','venue_ids']<>'{}' or length(trim(p_values->>'display_name')) not between 1 and 160 or p_values->>'identifier' !~ '^[^@[:space:]]+@[^@[:space:]]+$'
      then raise exception 'INVALID_STAFF_COMMAND';end if;
    requested_role:=(p_values->>'role')::public.user_role;requested_scope:=(p_values->>'scope')::public.user_scope;
    if requested_role is null or requested_scope is null or requested_role in ('SUPER_ADMIN','SYSTEM','CUSTOMER') then raise exception 'ROLE_NOT_PROVISIONABLE';end if;
    if requested_role='ADMIN' then perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);perform private.consume_step_up(p_grant,'PRIVILEGED_STAFF');
    end if;
    if private.current_role()='ADMIN' and requested_scope='CHAIN' and private.current_scope()<>'CHAIN' then raise exception 'SCOPE_ESCALATION';end if;
    select array_agg(x::uuid) into venues from jsonb_array_elements_text(p_values->'venue_ids') x;
    if requested_scope='VENUE' and coalesce(cardinality(venues),0)=0 then raise exception 'VENUE_ASSIGNMENT_REQUIRED';end if;
    foreach v in array coalesce(venues,'{}') loop if not exists(select 1 from public.venues where id=v and active) or (private.current_role()<>'SUPER_ADMIN' and not private.has_venue(v)) then raise exception 'VENUE_FORBIDDEN';end if;end loop;
    perform 1 from public.system_limits where id for update;
    if (select count(*) from public.staff_profiles where active)+(select count(*) from public.staff_admin_jobs where action='CREATE' and status<>'COMPLETED')>=(select max_users from public.system_limits where id) then raise exception 'STAFF_LIMIT';end if;
    target:=gen_random_uuid();
  elsif p_action in ('RESET_PASSWORD','RESET_MFA','DISABLE') then
    if not p_values ?& array['user_id','reason','identity_verified'] or p_values-array['user_id','reason','identity_verified']<>'{}' or (p_values->>'identity_verified')::boolean is distinct from true or length(trim(p_values->>'reason')) not between 8 and 2000 then raise exception 'IDENTITY_VERIFICATION_REQUIRED';end if;
    target:=(p_values->>'user_id')::uuid;
    if exists(select 1 from public.staff_admin_jobs where target_user_id=target and status<>'COMPLETED') then raise exception 'STAFF_COMMAND_PENDING';end if;
    perform public.revoke_staff_for_reset(target,p_grant,p_action='DISABLE');
    -- Fail closed until both Auth and PostgreSQL complete the authorized recovery.
    update public.staff_profiles set active=false where id=target;
  else raise exception 'INVALID_STAFF_COMMAND';end if;
  insert into public.staff_admin_jobs(actor_id,idempotency_key,target_user_id,action,values) values(auth.uid(),p_key,target,p_action,p_values) returning * into job;
  perform private.audit('STAFF_COMMAND_AUTHORIZED','staff_admin_jobs',job.id,null,null,jsonb_build_object('status',job.status));
  return jsonb_build_object('id',job.id,'user_id',target,'status',job.status);
end $function$;

create or replace function private.can_work_station(p_venue uuid,p_station uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.has_venue(p_venue)
    and private.current_role() in ('KITCHEN_ADMIN','KITCHEN_STAFF')
    and exists(select 1 from public.stations s where s.id=p_station and s.venue_id=p_venue and s.active)
$$;
CREATE OR REPLACE FUNCTION public.get_kitchen_board(p_venue uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.authorize(
    p_venue,
    array['ADMIN','KITCHEN_ADMIN','KITCHEN_STAFF','PASS','WAITER']::public.user_role[],
    false
  );

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',i.id,
        'order_id',o.id,
        'step_id',s.id,
        'step_number',s.step_number,
        'step_status',s.status,
        'order_source',o.origin,
        'table_name',t.name,
        'table_number',t.number,
        'pickup_at',tw.pickup_at,
        'service_label',case
          when o.origin='TAKEAWAY' and tw.pickup_at is not null
            then 'TAKEAWAY — ritiro '||to_char(tw.pickup_at at time zone v.timezone,'HH24:MI')
          when t.id is not null
            then coalesce(t.name,'Tavolo '||t.number::text)
          else null
        end,
        'dish_name',i.dish_name,
        'category_id',d.category_id,
        'category_name',c.name,
        'station_name',st.name,
        'quantity',i.quantity,
        'status',i.status,
        'station_id',i.station_id,
        'version',i.version,
        'created_at',o.created_at,
        'started_at',i.started_at,
        'can_prepare',private.can_work_station(p_venue,i.station_id),
        'can_deliver',
          o.origin<>'TAKEAWAY'
          and private.current_role()='WAITER'
          and t.id is not null
          and (
            private.responsible_waiter(t.id)=private.effective_user_id()
            or exists(
              select 1
              from public.table_assignments ta_runner
              where ta_runner.venue_id=p_venue
                and ta_runner.waiter_id=private.effective_user_id()
                and ta_runner.mode='RUNNER'
                and ta_runner.active
            )
          ),
        'removed_ingredients',
          coalesce((
            select jsonb_agg(ingredient_name order by ingredient_name)
            from public.order_item_removed_ingredients
            where order_item_id=i.id
          ),'[]'::jsonb),
        'variants',
          coalesce((
            select jsonb_agg(
              jsonb_build_object('group',group_name,'option',option_name)
              order by group_name,option_name
            )
            from public.order_item_variants
            where order_item_id=i.id
          ),'[]'::jsonb),
        'allergens',coalesce(i.allergen_snapshot,'[]'::jsonb)
      )
      order by coalesce(tw.pickup_at,o.created_at),o.created_at,s.step_number,i.dish_name
    )
    from public.order_items i
    left join public.dishes d on d.id=i.dish_id
    left join public.categories c on c.id=d.category_id
    left join public.stations st on st.id=i.station_id
    join public.orders o on o.id=i.order_id
    join public.order_steps s on s.id=i.step_id
    join public.accounts a on a.id=o.account_id
    join public.venues v on v.id=o.venue_id
    left join public.tables t on t.id=a.table_id
    left join public.takeaway_orders tw on tw.order_id=o.id
    where i.venue_id=p_venue
      and i.status not in ('SERVED','CANCELLED')
      and a.floor_released_at is null
      and (
        private.is_role(array['ADMIN','KITCHEN_ADMIN','PASS']::public.user_role[])
        or (
          private.current_role()='WAITER'
          and o.origin<>'TAKEAWAY'
          and t.id is not null
          and (
            private.responsible_waiter(t.id)=private.effective_user_id()
            or (
              s.status='READY'
              and exists(
                select 1
                from public.table_assignments ta
                where ta.venue_id=p_venue
                  and ta.waiter_id=private.effective_user_id()
                  and ta.mode='RUNNER'
                  and ta.active
              )
            )
          )
        )
        or private.current_role()='KITCHEN_STAFF'
      )
  ),'[]'::jsonb);
end
$function$;

CREATE OR REPLACE FUNCTION public.configure_system_limits(p_limits jsonb, p_grant uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_limits is null or not p_limits ?& array['max_users','max_venues','max_tables_per_venue','max_dishes','max_devices','max_storage_bytes'] or p_limits-array['max_users','max_venues','max_tables_per_venue','max_dishes','max_devices','max_storage_bytes']<>'{}' then raise exception 'INVALID_LIMITS';end if;
  perform 1 from public.system_limits where id for update;
  if (p_limits->>'max_users')::int<(select count(*) from public.staff_profiles where active) or (p_limits->>'max_venues')::int<(select count(*) from public.venues where active)
    or (p_limits->>'max_tables_per_venue')::int<(select coalesce(max(n),0) from (select count(*) n from public.tables where active group by venue_id) x)
    or (p_limits->>'max_dishes')::int<(select count(*) from public.dishes where active) or (p_limits->>'max_devices')::int<(select count(*) from public.registered_devices where revoked_at is null) then raise exception 'LIMIT_BELOW_CURRENT_USAGE';end if;
  update public.system_limits set max_users=(p_limits->>'max_users')::int,max_venues=(p_limits->>'max_venues')::int,max_tables_per_venue=(p_limits->>'max_tables_per_venue')::int,max_dishes=(p_limits->>'max_dishes')::int,max_devices=(p_limits->>'max_devices')::int,max_storage_bytes=(p_limits->>'max_storage_bytes')::bigint where id;
  perform private.audit('SYSTEM_LIMITS_CHANGED','system_limits',null,null,null,p_limits);
end $function$;

CREATE OR REPLACE FUNCTION public.create_venue(p_name text, p_slug text, p_code text, p_address text, p_phone text, p_email text, p_timezone text, p_currency text, p_locale text, p_grant uuid, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.set_installation_status(p_status installation_status, p_step_up uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare current_status public.installation_status;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_reason is null or length(trim(p_reason)) not between 8 and 2000 then raise exception 'REASON_REQUIRED';end if;
  select status into current_status from public.restaurant_profile where id for update;
  if not ((current_status='ACTIVE' and p_status='SUSPENDED') or (current_status='SUSPENDED' and p_status='ACTIVE')) or p_status is null then raise exception 'INVALID_TRANSITION';end if;
  
  update public.restaurant_profile set status=p_status where id;
  perform private.audit('INSTALLATION_STATUS_CHANGED','restaurant_profile',null,null,jsonb_build_object('status',current_status),jsonb_build_object('status',p_status,'reason',trim(p_reason)));
end $function$;

CREATE OR REPLACE FUNCTION public.update_staff_access(p_user uuid, p_name text, p_role user_role, p_scope user_scope, p_venues uuid[], p_version bigint, p_reason text, p_grant uuid, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target public.staff_profiles; venue uuid; old_venues uuid[]; requested uuid[]; response jsonb; changed boolean;
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  if private.impersonation_id() is not null or not private.can_manage_staff(p_user) then raise exception 'FORBIDDEN' using errcode='42501';end if;
  if p_name is null or length(trim(p_name)) not between 1 and 160 or p_reason is null or length(trim(p_reason)) not between 8 and 2000
    or p_role is null or p_scope is null or p_venues is null or cardinality(p_venues)>100 or array_position(p_venues,null) is not null then
    raise exception 'INVALID_STAFF_COMMAND';
  end if;
  if (private.current_role()='SUPER_ADMIN' and p_role<>'ADMIN') or (private.current_role()='ADMIN' and p_role in ('ADMIN','SUPER_ADMIN','SYSTEM','CUSTOMER')) then
    raise exception 'ROLE_NOT_PROVISIONABLE';
  end if;
  if p_scope='CHAIN' and private.current_scope()<>'CHAIN' then raise exception 'SCOPE_ESCALATION';end if;
  select coalesce(array_agg(distinct v order by v),'{}') into requested from unnest(p_venues) v;
  if p_scope='VENUE' and cardinality(requested)=0 then raise exception 'VENUE_ASSIGNMENT_REQUIRED';end if;
  foreach venue in array requested loop
    if not exists(select 1 from public.venues where id=venue and active) or not private.has_venue(venue) then raise exception 'VENUE_FORBIDDEN' using errcode='42501';end if;
  end loop;
  response:=private.idempotency_begin('STAFF_ACCESS',p_key,jsonb_build_object('id',p_user,'name',trim(p_name),'role',p_role,'scope',p_scope,'venues',requested,'version',p_version,'reason',trim(p_reason)));
  if response is not null then return response;end if;
  select * into target from public.staff_profiles where id=p_user for update;
  if target.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if exists(select 1 from public.staff_admin_jobs where target_user_id=p_user and status<>'COMPLETED') then raise exception 'STAFF_COMMAND_PENDING';end if;
  if target.role='ADMIN' or p_role='ADMIN' then
    perform private.consume_step_up(p_grant,case when private.current_role()='SUPER_ADMIN' then 'PRIVILEGED_STAFF' else 'STAFF_CHANGE' end,p_user);
  end if;
  select coalesce(array_agg(venue_id order by venue_id),'{}') into old_venues from public.staff_venue_assignments where user_id=p_user and active;
  changed:=target.role<>p_role or target.scope<>p_scope or old_venues<>requested;
  update public.staff_profiles set display_name=trim(p_name),role=p_role,scope=p_scope where id=p_user;
  update public.staff_venue_assignments set active=false where user_id=p_user;
  foreach venue in array requested loop
    insert into public.staff_venue_assignments(user_id,venue_id) values(p_user,venue) on conflict(user_id,venue_id) do update set active=true;
  end loop;
  if changed then
    update public.table_assignments set active=false where waiter_id=p_user and active and (p_role<>'WAITER' or (p_scope='VENUE' and not venue_id=any(requested)));
    update public.station_staff_assignments set active=false where user_id=p_user and active and (p_role<>'KITCHEN_STAFF' or (p_scope='VENUE' and not venue_id=any(requested)));
    update public.cashier_assignments set active=false where user_id=p_user and active and (p_role<>'CASHIER' or (p_scope='VENUE' and not venue_id=any(requested)));
    perform private.invalidate_staff_access(p_user);
    delete from private.staff_pins where user_id=p_user;
  end if;
  insert into private.staff_access_change_reasons(actor_id,target_id,operation_key,reason) values(auth.uid(),p_user,p_key,trim(p_reason));
  foreach venue in array (select coalesce(array_agg(distinct v),'{}') from unnest(old_venues||requested) v) loop
    if (venue=any(old_venues)) is distinct from (venue=any(requested)) then
      perform private.audit('STAFF_VENUE_ACCESS_CHANGED','staff_profiles',p_user,venue,
        jsonb_build_object('active',venue=any(old_venues)),jsonb_build_object('active',venue=any(requested)));
    end if;
  end loop;
  perform private.audit('STAFF_ACCESS_CHANGED','staff_profiles',p_user,null,to_jsonb(target),jsonb_build_object('role',p_role,'scope',p_scope));
  select jsonb_build_object('id',id,'version',version) into response from public.staff_profiles where id=p_user;
  return private.idempotency_finish('STAFF_ACCESS',p_key,response);
end $function$;

CREATE OR REPLACE FUNCTION public.update_venue(p_venue uuid, p_version bigint, p_values jsonb, p_grant uuid, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

commit;
$plateform_source_62$]::text[]);
COMMIT;

SELECT v.name AS sede,s.reservations_enabled AS prenotazioni_online,
       s.customer_bill_request AS richiesta_conto,s.returns_enabled AS piatti_tornati_indietro,
       (SELECT licensed FROM public.feature_flags WHERE name='RESERVATION_MESSAGING') AS messaggi_prenotazioni
FROM public.venue_settings s JOIN public.venues v ON v.id=s.venue_id WHERE v.active;
