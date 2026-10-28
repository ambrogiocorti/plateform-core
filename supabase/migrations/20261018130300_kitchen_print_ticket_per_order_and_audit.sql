-- STEP 7 / §66 e §91 Stampe cucina.
-- 1. La stampa automatica creava un job (e quindi uno scontrino) per ogni riga d'ordine: un
--    ordine di cinque piatti produceva cinque comande separate sulla stessa stampante. Ora le
--    righe dello stesso ordine inserite nella stessa transazione per la stessa stampante di
--    stazione confluiscono in un'unica comanda QUEUED (stesso created_at = now() della
--    transazione). Il trigger resta DEFERRABLE INITIALLY DEFERRED, quindi varianti e
--    ingredienti rimossi sono già presenti quando la riga viene aggiunta.
-- 2. I job accodati automaticamente (nuovo ordine e RIFARE) non producevano l'evento audit
--    PRINT_REQUESTED richiesto dalla §91: lo producevano soltanto le richieste manuali. Ora
--    ogni nuova comanda automatica registra PRINT_REQUESTED con evento ed origine.

create or replace function private.queue_kitchen_print()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare station public.stations; a public.accounts; actor uuid; job_ref uuid; line jsonb;
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
  line:=jsonb_build_object(
    'name',new.dish_name,'quantity',new.quantity,
    'step',(select step_number from public.order_steps where id=new.step_id),
    'removed',(select coalesce(jsonb_agg(ingredient_name),'[]'::jsonb) from public.order_item_removed_ingredients where order_item_id=new.id),
    'variants',(select coalesce(jsonb_agg(jsonb_build_object('group',group_name,'option',option_name)),'[]'::jsonb) from public.order_item_variants where order_item_id=new.id)
  );

  select id into job_ref
  from public.print_jobs
  where order_id=new.order_id
    and print_device_id=station.printer_id
    and kind='KITCHEN'
    and status='QUEUED'
    and payload->>'event'='ORDER_ITEM_CREATED'
    and created_at=now()
  order by id
  limit 1
  for update;

  if job_ref is not null then
    update public.print_jobs
       set payload=jsonb_set(payload,'{lines}',coalesce(payload->'lines','[]'::jsonb)||line)
     where id=job_ref;
    return new;
  end if;

  insert into public.print_jobs(
    venue_id,print_device_id,account_id,order_id,kind,payload,requested_by,idempotency_key
  ) values(
    new.venue_id,station.printer_id,a.id,new.order_id,'KITCHEN',
    jsonb_build_object(
      'restaurant',(select name from public.restaurant_profile),
      'table',(select name from public.tables where id=a.table_id),
      'account',a.account_name,'at',clock_timestamp(),'document','COMANDA · NON FISCALE',
      'event','ORDER_ITEM_CREATED',
      'lines',jsonb_build_array(line)
    ),actor,gen_random_uuid()
  ) returning id into job_ref;
  perform private.audit(
    'PRINT_REQUESTED','print_jobs',job_ref,new.venue_id,null,
    jsonb_build_object('status','QUEUED','event','ORDER_ITEM_CREATED','origin','STATION_AUTO_PRINT','station_id',station.id)
  );
  return new;
end
$$;

create or replace function private.queue_kitchen_remake_print()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare station public.stations; a public.accounts; actor uuid; job_ref uuid;
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
  ) returning id into job_ref;
  perform private.audit(
    'PRINT_REQUESTED','print_jobs',job_ref,new.venue_id,null,
    jsonb_build_object('status','QUEUED','event','ITEM_REMAKE','origin','STATION_AUTO_PRINT','station_id',station.id)
  );
  return new;
end
$$;

revoke all on function private.queue_kitchen_print() from public, anon, authenticated;
revoke all on function private.queue_kitchen_remake_print() from public, anon, authenticated;
