-- STEP 2 gate test. Run only on isolated DEVELOPMENT; every fixture is rolled back.
begin;

create temporary table step2_runtime(
  key text primary key,
  value uuid,
  text_value text
) on commit drop;
grant select,insert,update,delete on step2_runtime to authenticated;

-- Reuse the installation's active development venue, but isolate every operational fixture.
insert into auth.users(id) values
  ('92000000-0000-4000-8000-000000000001'),
  ('92000000-0000-4000-8000-000000000002'),
  ('92000000-0000-4000-8000-000000000003'),
  ('92000000-0000-4000-8000-000000000004');
insert into public.staff_profiles(id,display_name,role,scope) values
  ('92000000-0000-4000-8000-000000000001','Step2 waiter','WAITER','VENUE'),
  ('92000000-0000-4000-8000-000000000002','Step2 kitchen','KITCHEN_STAFF','VENUE'),
  ('92000000-0000-4000-8000-000000000003','Step2 pass','PASS','VENUE'),
  ('92000000-0000-4000-8000-000000000004','Step2 runner','WAITER','VENUE');
insert into public.staff_venue_assignments(user_id,venue_id)
select s.id,v.id from public.staff_profiles s cross join lateral (
  select id from public.venues where active order by created_at limit 1
) v where s.id::text like '92000000-%';
insert into auth.sessions(id,user_id) values
  ('93000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001'),
  ('93000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002'),
  ('93000000-0000-4000-8000-000000000003','92000000-0000-4000-8000-000000000003'),
  ('93000000-0000-4000-8000-000000000004','92000000-0000-4000-8000-000000000004');
insert into private.staff_sessions(session_id,user_id,full_auth_at,unlocked_until)
select id,user_id,clock_timestamp(),clock_timestamp()+interval '2 hours'
from auth.sessions where user_id::text like '92000000-%';

insert into public.rooms(id,venue_id,name)
select '94000000-0000-4000-8000-000000000001',id,'Step2 room' from public.venues where active order by created_at limit 1;
insert into public.room_layouts(id,venue_id,room_id,name,active)
select '94000000-0000-4000-8000-000000000002',venue_id,id,'Step2 layout',true
from public.rooms where id='94000000-0000-4000-8000-000000000001';
insert into public.zones(id,venue_id,room_id,name)
select '94000000-0000-4000-8000-000000000003',venue_id,id,'Step2 zone'
from public.rooms where id='94000000-0000-4000-8000-000000000001';
insert into public.tables(id,venue_id,room_id,layout_id,zone_id,number,name,seats)
select '94000000-0000-4000-8000-000000000004',r.venue_id,r.id,l.id,z.id,902,'Step2 table',6
from public.rooms r join public.room_layouts l on l.room_id=r.id join public.zones z on z.room_id=r.id
where r.id='94000000-0000-4000-8000-000000000001';
insert into public.stations(id,venue_id,name)
select '94000000-0000-4000-8000-000000000005',id,'Step2 kitchen station'
from public.venues where active order by created_at limit 1;
insert into public.categories(id,name,sort_order) values('94000000-0000-4000-8000-000000000006','Step2 category',1);
insert into public.ingredients(id,name) values('94000000-0000-4000-8000-000000000007','Step2 ingredient');
insert into public.allergens(id,code,name) values('94000000-0000-4000-8000-000000000008','STEP2_ALLERGEN','Step2 allergen');
insert into public.ingredient_allergens(ingredient_id,allergen_id) values('94000000-0000-4000-8000-000000000007','94000000-0000-4000-8000-000000000008');
insert into public.dishes(id,category_id,name,price_cents)
values('94000000-0000-4000-8000-000000000009','94000000-0000-4000-8000-000000000006','Step2 dish',1590);
insert into public.dish_ingredients(dish_id,ingredient_id,removable)
values('94000000-0000-4000-8000-000000000009','94000000-0000-4000-8000-000000000007',true);
insert into public.variant_groups(id,dish_id,name,required,max_selections)
values('94000000-0000-4000-8000-000000000010','94000000-0000-4000-8000-000000000009','Step2 variant',true,1);
insert into public.variant_options(id,group_id,label)
values('94000000-0000-4000-8000-000000000011','94000000-0000-4000-8000-000000000010','Standard');
insert into public.venue_dish_settings(venue_id,dish_id,availability,availability_date,local_station_id)
select id,'94000000-0000-4000-8000-000000000009',2,(now() at time zone timezone)::date,'94000000-0000-4000-8000-000000000005'
from public.venues where active order by created_at limit 1;
insert into public.dish_station_assignments(venue_id,dish_id,station_id,is_primary)
select id,'94000000-0000-4000-8000-000000000009','94000000-0000-4000-8000-000000000005',true
from public.venues where active order by created_at limit 1;
insert into public.station_staff_assignments(venue_id,station_id,user_id,active)
select id,'94000000-0000-4000-8000-000000000005','92000000-0000-4000-8000-000000000002',true
from public.venues where active order by created_at limit 1;
insert into public.table_assignments(venue_id,waiter_id,mode,table_id)
select id,'92000000-0000-4000-8000-000000000001','TABLE','94000000-0000-4000-8000-000000000004'
from public.venues where active order by created_at limit 1;
insert into public.table_assignments(venue_id,waiter_id,mode)
select id,'92000000-0000-4000-8000-000000000004','RUNNER'
from public.venues where active order by created_at limit 1;

-- WAITER: table -> multiple isolated accounts -> configured order.
select set_config('request.jwt.claims',jsonb_build_object(
  'sub','92000000-0000-4000-8000-000000000001','aal','aal2',
  'iat',extract(epoch from now())::bigint,'session_id','93000000-0000-4000-8000-000000000001',
  'amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())::bigint))
)::text,true);
set local role authenticated;
insert into step2_runtime(key,value,text_value)
select 'account', (r->>'id')::uuid, r->>'code'
from (select public.create_account('94000000-0000-4000-8000-000000000004','Step2 A',2,null,'95000000-0000-4000-8000-000000000001') r) q;
insert into step2_runtime(key,value,text_value)
select 'second_account', (r->>'id')::uuid, r->>'code'
from (select public.create_account('94000000-0000-4000-8000-000000000004','Step2 B',1,null,'95000000-0000-4000-8000-000000000002') r) q;
do $$ begin
  if (select text_value from step2_runtime where key='account') !~ '^[0-9]{6}$'
    or (select text_value from step2_runtime where key='second_account') !~ '^[0-9]{6}$'
    or (select text_value from step2_runtime where key='account')=(select text_value from step2_runtime where key='second_account')
    then raise exception 'TEST_STEP2_ACCOUNT_CODES';end if;
end $$;
insert into step2_runtime(key,value)
select 'order',(r->>'id')::uuid
from (select public.create_order(
  (select value from step2_runtime where key='account'),
  jsonb_build_array(jsonb_build_object(
    'dish_id','94000000-0000-4000-8000-000000000009',
    'quantity',1,'step',1,
    'removed_ingredients',jsonb_build_array('94000000-0000-4000-8000-000000000007'),
    'variant_options',jsonb_build_array('94000000-0000-4000-8000-000000000011')
  )),
  '95000000-0000-4000-8000-000000000003',
  (select version from public.accounts where id=(select value from step2_runtime where key='account'))
) r) q;
insert into step2_runtime(key,value)
select 'item',id from public.order_items where order_id=(select value from step2_runtime where key='order');
insert into step2_runtime(key,value)
select 'step',id from public.order_steps where order_id=(select value from step2_runtime where key='order') and step_number=1;
do $$ begin
  if (select availability from public.venue_dish_settings where dish_id='94000000-0000-4000-8000-000000000009')<>1
    then raise exception 'TEST_STEP2_ATOMIC_AVAILABILITY';end if;
  if not exists(select 1 from public.order_items where id=(select value from step2_runtime where key='item')
    and unit_price_cents=1590 and status='RECEIVED'
    and ingredient_snapshot='[]'::jsonb
    and jsonb_array_length(allergen_snapshot)=0)
    then raise exception 'TEST_STEP2_SNAPSHOT_OR_SELECTIONS';end if;
  if not exists(select 1 from public.order_item_removed_ingredients where order_item_id=(select value from step2_runtime where key='item'))
    or not exists(select 1 from public.order_item_variants where order_item_id=(select value from step2_runtime where key='item'))
    then raise exception 'TEST_STEP2_ORDER_OPTIONS';end if;
end $$;
reset role;

-- KITCHEN: authoritative ticket and state machine.
select set_config('request.jwt.claims',jsonb_build_object(
  'sub','92000000-0000-4000-8000-000000000002','aal','aal2',
  'iat',extract(epoch from now())::bigint,'session_id','93000000-0000-4000-8000-000000000002',
  'amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())::bigint))
)::text,true);
set local role authenticated;
do $$ declare board jsonb; begin
  board:=public.get_kitchen_board((select venue_id from public.tables where id='94000000-0000-4000-8000-000000000004'));
  if jsonb_array_length(board)<>1 or (board->0->>'can_prepare')::boolean is distinct from true
    then raise exception 'TEST_STEP2_KITCHEN_BOARD';end if;
end $$;
select public.transition_order_item(
  (select value from step2_runtime where key='item'),'IN_PREPARATION',
  (select version from public.order_items where id=(select value from step2_runtime where key='item'))
);
select public.transition_order_item(
  (select value from step2_runtime where key='item'),'READY',
  (select version from public.order_items where id=(select value from step2_runtime where key='item'))
);
reset role;

-- PASS: coordinates the prepared step.
select set_config('request.jwt.claims',jsonb_build_object(
  'sub','92000000-0000-4000-8000-000000000003','aal','aal2',
  'iat',extract(epoch from now())::bigint,'session_id','93000000-0000-4000-8000-000000000003',
  'amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())::bigint))
)::text,true);
set local role authenticated;
select public.mark_step_ready((select value from step2_runtime where key='step'));
do $$ begin
  if not exists(select 1 from public.order_steps where id=(select value from step2_runtime where key='step') and status='READY')
    then raise exception 'TEST_STEP2_PASS_READY';end if;
end $$;
reset role;

-- WAITER: service completes the step and the order.
select set_config('request.jwt.claims',jsonb_build_object(
  'sub','92000000-0000-4000-8000-000000000001','aal','aal2',
  'iat',extract(epoch from now())::bigint,'session_id','93000000-0000-4000-8000-000000000001',
  'amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())::bigint))
)::text,true);
set local role authenticated;
select public.deliver_step((select value from step2_runtime where key='step'),true);
do $$ begin
  if not exists(select 1 from public.orders where id=(select value from step2_runtime where key='order') and status='SERVED')
    or not exists(select 1 from public.order_items where id=(select value from step2_runtime where key='item') and status='SERVED')
    or not exists(select 1 from public.order_steps where id=(select value from step2_runtime where key='step') and status='SERVED')
    then raise exception 'TEST_STEP2_SERVICE_NOT_SERVED';end if;
  if not exists(select 1 from public.realtime_signals where venue_id=(select venue_id from public.tables where id='94000000-0000-4000-8000-000000000004')
    and topic in ('FLOOR','ACCOUNT','KITCHEN'))
    then raise exception 'TEST_STEP2_REALTIME_SIGNAL_MISSING';end if;
end $$;
reset role;

rollback;
