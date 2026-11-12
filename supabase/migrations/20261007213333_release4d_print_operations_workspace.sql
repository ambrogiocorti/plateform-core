
alter table public.stations
  add column if not exists print_events text[] not null default array['ORDER_ITEM_CREATED']::text[];

alter table public.stations
  drop constraint if exists stations_print_events_check;
alter table public.stations
  add constraint stations_print_events_check
  check(
    print_events <@ array['ORDER_ITEM_CREATED','ITEM_REMAKE']::text[]
    and array_position(print_events,null) is null
    and cardinality(print_events)<=2
  );

create or replace function public.configure_station_printing(
  p_station uuid,
  p_printer uuid,
  p_auto boolean,
  p_events text[],
  p_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare s public.stations;
begin
  select * into s from public.stations where id=p_station for update;
  if s.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(s.venue_id,array['ADMIN']::public.user_role[]);
  if s.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  if p_auto is null
     or p_events is null
     or array_position(p_events,null) is not null
     or cardinality(p_events)>2
     or not (p_events <@ array['ORDER_ITEM_CREATED','ITEM_REMAKE']::text[])
  then raise exception 'INVALID_PRINT_EVENTS'; end if;
  if p_printer is not null
     and not exists(
       select 1 from public.print_devices
       where id=p_printer and venue_id=s.venue_id and active
     )
  then raise exception 'INVALID_PRINT_DEVICE'; end if;
  if p_auto and (p_printer is null or cardinality(p_events)=0) then
    raise exception 'PRINT_DEVICE_REQUIRED';
  end if;

  update public.stations
  set printer_id=p_printer,auto_print=p_auto,print_events=p_events
  where id=s.id
  returning * into s;

  return jsonb_build_object(
    'id',s.id,'version',s.version,'printer_id',s.printer_id,
    'auto_print',s.auto_print,'print_events',to_jsonb(s.print_events)
  );
end
$$;

create or replace function public.configure_cash_register_printer(
  p_register uuid,
  p_printer uuid,
  p_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare r public.cash_registers;
begin
  select * into r from public.cash_registers where id=p_register for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN']::public.user_role[]);
  if r.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  if p_printer is not null
     and not exists(
       select 1 from public.print_devices
       where id=p_printer and venue_id=r.venue_id and active
     )
  then raise exception 'INVALID_PRINT_DEVICE'; end if;
  update public.cash_registers set printer_id=p_printer where id=r.id returning * into r;
  return jsonb_build_object('id',r.id,'version',r.version,'printer_id',r.printer_id);
end
$$;

create or replace function public.get_print_admin_workspace(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[],false);
  return jsonb_build_object(
    'devices',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',d.id,'name',d.name,'driver',d.driver,'endpoint',d.endpoint,
        'active',d.active,'allowed_roles',to_jsonb(d.allowed_roles),
        'version',d.version
      ) order by d.name,d.id)
      from public.print_devices d where d.venue_id=p_venue
    ),'[]'::jsonb),
    'stations',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',s.id,'name',s.name,'active',s.active,'version',s.version,
        'printer_id',s.printer_id,'auto_print',s.auto_print,
        'print_events',to_jsonb(s.print_events)
      ) order by s.name,s.id)
      from public.stations s where s.venue_id=p_venue
    ),'[]'::jsonb),
    'registers',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',r.id,'name',r.name,'code',r.code,'active',r.active,
        'status',r.status,'version',r.version,'printer_id',r.printer_id
      ) order by r.name,r.id)
      from public.cash_registers r where r.venue_id=p_venue
    ),'[]'::jsonb),
    'jobs',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',j.id,'print_device_id',j.print_device_id,'device_name',d.name,
        'driver',d.driver,'kind',j.kind,'status',j.status,'attempts',j.attempts,
        'last_error_code',j.last_error_code,'lease_until',j.lease_until,
        'account_id',j.account_id,'order_id',j.order_id,'created_at',j.created_at,
        'completed_at',j.completed_at
      ) order by j.created_at desc,j.id desc)
      from (
        select * from public.print_jobs
        where venue_id=p_venue
        order by created_at desc,id desc
        limit 100
      ) j
      join public.print_devices d on d.id=j.print_device_id
    ),'[]'::jsonb)
  );
end
$$;

create or replace function public.get_account_print_options(p_account uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare a public.accounts;
begin
  select * into a from public.accounts where id=p_account;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['ADMIN','CASHIER','WAITER']::public.user_role[],false);
  if private.current_role()='WAITER'
     and private.responsible_waiter(a.table_id) is distinct from private.effective_user_id()
  then raise exception 'RESPONSIBLE_WAITER_REQUIRED'; end if;

  return jsonb_build_object(
    'devices',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',d.id,'name',d.name,'driver',d.driver
      ) order by d.name,d.id)
      from public.print_devices d
      where d.venue_id=a.venue_id
        and d.active
        and private.current_role()=any(d.allowed_roles)
    ),'[]'::jsonb),
    'can_receipt',
      (private.account_balance(a.id)->>'remaining_cents')::bigint=0
      and (private.account_balance(a.id)->>'pending_cents')::bigint=0
  );
end
$$;

create or replace function public.request_register_account_print(
  p_account uuid,
  p_register uuid,
  p_kind text,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare a public.accounts; r public.cash_registers;
begin
  select * into a from public.accounts where id=p_account;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  select * into r from public.cash_registers where id=p_register and venue_id=a.venue_id;
  if r.id is null or not r.active then raise exception 'INVALID_CASH_REGISTER'; end if;
  perform private.authorize(a.venue_id,array['ADMIN','CASHIER']::public.user_role[]);
  if not private.can_use_register(r.id) then raise exception 'REGISTER_FORBIDDEN'; end if;
  if r.printer_id is null then raise exception 'PRINT_DEVICE_REQUIRED'; end if;
  return public.request_account_print(a.id,r.printer_id,p_kind,p_key);
end
$$;

create or replace function public.request_station_order_print(
  p_order uuid,
  p_station uuid,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  o public.orders;
  s public.stations;
  a public.accounts;
  ref uuid;
  previous jsonb;
begin
  select * into o from public.orders where id=p_order;
  if o.id is null then raise exception 'NOT_FOUND'; end if;
  select * into s from public.stations where id=p_station and venue_id=o.venue_id and active;
  if s.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(
    o.venue_id,
    array['ADMIN','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[]
  );
  if private.current_role()='KITCHEN_STAFF'
     and not private.can_work_station(o.venue_id,s.id)
  then raise exception 'STATION_FORBIDDEN'; end if;
  if s.printer_id is null then raise exception 'PRINT_DEVICE_REQUIRED'; end if;
  perform private.print_authorize(s.printer_id);

  previous:=private.idempotency_begin(
    'station_order_print',p_key,jsonb_build_object('order',p_order,'station',p_station)
  );
  if previous is not null then return previous; end if;

  select * into a from public.accounts where id=o.account_id;
  insert into public.print_jobs(
    venue_id,print_device_id,account_id,order_id,kind,payload,requested_by,idempotency_key
  )
  values(
    o.venue_id,s.printer_id,a.id,o.id,'KITCHEN',
    jsonb_build_object(
      'restaurant',(select name from public.restaurant_profile),
      'table',(select name from public.tables where id=a.table_id),
      'account',a.account_name,
      'at',clock_timestamp(),
      'document','COMANDA MANUALE · NON FISCALE',
      'station',s.name,
      'lines',coalesce((
        select jsonb_agg(jsonb_build_object(
          'name',i.dish_name,'quantity',i.quantity,
          'step',os.step_number,'status',i.status,
          'removed',coalesce((
            select jsonb_agg(ri.ingredient_name order by ri.ingredient_name)
            from public.order_item_removed_ingredients ri where ri.order_item_id=i.id
          ),'[]'::jsonb),
          'variants',coalesce((
            select jsonb_agg(jsonb_build_object('group',v.group_name,'option',v.option_name) order by v.group_name,v.option_name)
            from public.order_item_variants v where v.order_item_id=i.id
          ),'[]'::jsonb)
        ) order by os.step_number,i.created_at,i.id)
        from public.order_items i
        join public.order_steps os on os.id=i.step_id
        where i.order_id=o.id and i.station_id=s.id and i.status<>'CANCELLED'
      ),'[]'::jsonb)
    ),
    private.effective_user_id(),p_key
  )
  returning id into ref;

  perform private.audit(
    'PRINT_REQUESTED','print_jobs',ref,o.venue_id,null,
    jsonb_build_object('order_id',o.id,'station_id',s.id,'status','QUEUED')
  );
  return private.idempotency_finish(
    'station_order_print',p_key,jsonb_build_object('id',ref)
  );
end
$$;

create or replace function private.queue_kitchen_print()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare station public.stations; a public.accounts; key uuid; actor uuid;
begin
  select * into station
  from public.stations
  where id=new.station_id and auto_print and active
    and 'ORDER_ITEM_CREATED'=any(print_events);
  if station.printer_id is null then return new; end if;
  select a0.* into a
  from public.accounts a0 join public.orders o on o.account_id=a0.id
  where o.id=new.order_id;
  select created_by into actor from public.orders where id=new.order_id;
  if not exists(select 1 from public.staff_profiles where id=actor) then
    actor:=private.responsible_waiter(a.table_id);
  end if;
  if actor is null then return new; end if;
  key:=gen_random_uuid();
  insert into public.print_jobs(
    venue_id,print_device_id,account_id,order_id,kind,payload,requested_by,idempotency_key
  ) values(
    new.venue_id,station.printer_id,a.id,new.order_id,'KITCHEN',
    jsonb_build_object(
      'restaurant',(select name from public.restaurant_profile),
      'table',(select name from public.tables where id=a.table_id),
      'account',a.account_name,'at',clock_timestamp(),'document','COMANDA · NON FISCALE',
      'event','ORDER_ITEM_CREATED',
      'lines',jsonb_build_array(jsonb_build_object(
        'name',new.dish_name,'quantity',new.quantity,
        'step',(select step_number from public.order_steps where id=new.step_id),
        'removed',(select coalesce(jsonb_agg(ingredient_name),'[]'::jsonb) from public.order_item_removed_ingredients where order_item_id=new.id),
        'variants',(select coalesce(jsonb_agg(jsonb_build_object('group',group_name,'option',option_name)),'[]'::jsonb) from public.order_item_variants where order_item_id=new.id)
      ))
    ),actor,key
  );
  return new;
end
$$;

create or replace function private.queue_kitchen_remake_print()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare station public.stations; a public.accounts; actor uuid;
begin
  if not (
    old.status in ('READY','SERVED')
    and new.status='RECEIVED'
    and new.version>old.version
  ) then return new; end if;

  select * into station
  from public.stations
  where id=new.station_id and auto_print and active
    and 'ITEM_REMAKE'=any(print_events);
  if station.printer_id is null then return new; end if;

  select a0.* into a
  from public.accounts a0 join public.orders o on o.account_id=a0.id
  where o.id=new.order_id;
  actor:=private.effective_user_id();
  if actor is null then return new; end if;

  insert into public.print_jobs(
    venue_id,print_device_id,account_id,order_id,kind,payload,requested_by,idempotency_key
  ) values(
    new.venue_id,station.printer_id,a.id,new.order_id,'KITCHEN',
    jsonb_build_object(
      'restaurant',(select name from public.restaurant_profile),
      'table',(select name from public.tables where id=a.table_id),
      'account',a.account_name,'at',clock_timestamp(),'document','COMANDA RIFARE · NON FISCALE',
      'event','ITEM_REMAKE',
      'lines',jsonb_build_array(jsonb_build_object(
        'name',new.dish_name,'quantity',new.quantity,
        'step',(select step_number from public.order_steps where id=new.step_id)
      ))
    ),actor,gen_random_uuid()
  );
  return new;
end
$$;

drop trigger if exists kitchen_remake_print on public.order_items;
create trigger kitchen_remake_print
after update of status on public.order_items
for each row execute function private.queue_kitchen_remake_print();

revoke all on function public.configure_station_printing(uuid,uuid,boolean,text[],bigint) from public,anon;
revoke all on function public.configure_cash_register_printer(uuid,uuid,bigint) from public,anon;
revoke all on function public.get_print_admin_workspace(uuid) from public,anon;
revoke all on function public.get_account_print_options(uuid) from public,anon;
revoke all on function public.request_register_account_print(uuid,uuid,text,uuid) from public,anon;
revoke all on function public.request_station_order_print(uuid,uuid,uuid) from public,anon;

grant execute on function public.configure_station_printing(uuid,uuid,boolean,text[],bigint) to authenticated,service_role;
grant execute on function public.configure_cash_register_printer(uuid,uuid,bigint) to authenticated,service_role;
grant execute on function public.get_print_admin_workspace(uuid) to authenticated,service_role;
grant execute on function public.get_account_print_options(uuid) to authenticated,service_role;
grant execute on function public.request_register_account_print(uuid,uuid,text,uuid) to authenticated,service_role;
grant execute on function public.request_station_order_print(uuid,uuid,uuid) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
('public.configure_station_printing(uuid,uuid,boolean,text[],bigint)','authenticated'),
('public.configure_cash_register_printer(uuid,uuid,bigint)','authenticated'),
('public.get_print_admin_workspace(uuid)','authenticated'),
('public.get_account_print_options(uuid)','authenticated'),
('public.request_register_account_print(uuid,uuid,text,uuid)','authenticated'),
('public.request_station_order_print(uuid,uuid,uuid)','authenticated')
on conflict do nothing;
