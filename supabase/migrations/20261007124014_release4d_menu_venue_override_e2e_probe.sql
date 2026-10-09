
create or replace function private.test_menu_venue_override_e2e()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_primary constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_second uuid:=gen_random_uuid();
  v_category uuid:=gen_random_uuid();
  v_shared_dish uuid:=gen_random_uuid();
  v_hidden_dish uuid:=gen_random_uuid();
  v_menu uuid:=gen_random_uuid();
  v_at timestamptz:='2099-04-01 18:00:00+00'::timestamptz;
  v_primary_payload jsonb;
  v_second_payload jsonb;
  v_primary_shared jsonb;
  v_second_shared jsonb;
  v_primary_hidden boolean;
  v_second_hidden boolean;
  v_evidence jsonb;
  v_detail text;
begin
  begin
    update public.feature_flags
    set licensed=true
    where name in ('MULTI_VENUE','MULTI_MENU_QR');

    insert into public.venues(
      id,name,slug,code,address,phone,timezone,currency,locale,active,operational_status
    ) values(
      v_second,
      'E2E Menu Override Venue',
      'e2e-menu-override-venue',
      'E2EMOV',
      'Via Menu Override 2',
      '+390000006002',
      'Europe/Rome',
      'EUR',
      'it-IT',
      true,
      'OPEN'
    );

    insert into public.venue_features(venue_id,name,enabled)
    values
      (v_primary,'MULTI_MENU_QR',true),
      (v_second,'MULTI_MENU_QR',true)
    on conflict(venue_id,name) do update
      set enabled=true;

    insert into public.categories(id,name,sort_order,active)
    values(v_category,'E2E Override Category',1,true);

    insert into public.dishes(
      id,category_id,name,description,price_cents,active,sort_order,schedule_mode
    ) values
      (
        v_shared_dish,v_category,'E2E Shared Dish','Shared catalog dish',
        1000,true,1,'ALWAYS'
      ),
      (
        v_hidden_dish,v_category,'E2E Hidden Dish','Venue visibility dish',
        800,true,2,'ALWAYS'
      );

    insert into public.menus(
      id,name,slug,active,published,weekdays,sort_order
    ) values(
      v_menu,
      'E2E Venue Override Menu',
      'e2e-venue-override-menu',
      true,
      true,
      array[1,2,3,4,5,6,7],
      1
    );

    insert into public.menu_venues(menu_id,venue_id,sort_order)
    values
      (v_menu,v_primary,1),
      (v_menu,v_second,2);

    insert into public.menu_categories(menu_id,category_id,sort_order)
    values(v_menu,v_category,1);

    insert into public.menu_dishes(menu_id,dish_id,sort_order)
    values
      (v_menu,v_shared_dish,1),
      (v_menu,v_hidden_dish,2);

    insert into public.venue_dish_settings(
      venue_id,dish_id,enabled,local_price_cents,availability,availability_date
    ) values
      (v_primary,v_shared_dish,true,1200,5,'2099-04-01'::date),
      (v_second,v_shared_dish,true,1500,2,'2099-04-01'::date),
      (v_primary,v_hidden_dish,true,null,3,'2099-04-01'::date),
      (v_second,v_hidden_dish,false,null,3,'2099-04-01'::date)
    on conflict(venue_id,dish_id) do update
    set enabled=excluded.enabled,
        local_price_cents=excluded.local_price_cents,
        availability=excluded.availability,
        availability_date=excluded.availability_date;

    v_primary_payload:=private.public_menu_payload(v_menu,v_primary,v_at);
    v_second_payload:=private.public_menu_payload(v_menu,v_second,v_at);

    select item
    into v_primary_shared
    from jsonb_array_elements(v_primary_payload->'categories') c
    cross join lateral jsonb_array_elements(c->'items') item
    where (item->>'id')::uuid=v_shared_dish
    limit 1;

    select item
    into v_second_shared
    from jsonb_array_elements(v_second_payload->'categories') c
    cross join lateral jsonb_array_elements(c->'items') item
    where (item->>'id')::uuid=v_shared_dish
    limit 1;

    select exists(
      select 1
      from jsonb_array_elements(v_primary_payload->'categories') c
      cross join lateral jsonb_array_elements(c->'items') item
      where (item->>'id')::uuid=v_hidden_dish
    )
    into v_primary_hidden;

    select exists(
      select 1
      from jsonb_array_elements(v_second_payload->'categories') c
      cross join lateral jsonb_array_elements(c->'items') item
      where (item->>'id')::uuid=v_hidden_dish
    )
    into v_second_hidden;

    if v_primary_shared is null
       or v_second_shared is null
       or (v_primary_shared->>'id')::uuid<>(v_second_shared->>'id')::uuid
       or (v_primary_shared->>'price_cents')::bigint<>1200
       or (v_second_shared->>'price_cents')::bigint<>1500
       or (v_primary_shared->>'availability')::integer<>5
       or (v_second_shared->>'availability')::integer<>2
       or not v_primary_hidden
       or v_second_hidden
       or (v_primary_payload->>'venue_id')::uuid<>v_primary
       or (v_second_payload->>'venue_id')::uuid<>v_second
    then
      raise exception 'MENU_VENUE_OVERRIDE_ASSERTION_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'shared_catalog_dish_id',v_shared_dish,
      'same_dish_id_across_venues',true,
      'primary_price_cents',1200,
      'second_price_cents',1500,
      'primary_availability',5,
      'second_availability',2,
      'primary_hidden_dish_visible',v_primary_hidden,
      'second_hidden_dish_visible',v_second_hidden,
      'venue_payloads_distinct',true,
      'catalog_not_cloned',true,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_MENU_VENUE_OVERRIDE_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_MENU_VENUE_OVERRIDE_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_menu_venue_override_e2e()
from public,anon,authenticated;
grant execute on function private.test_menu_venue_override_e2e()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'MENU_VENUE_OVERRIDE_E2E',
  'E2E',
  true,
  'The same shared catalog dish is rendered with venue-specific local price and availability, while venue-specific enabled=false hides a dish without cloning the catalog.'
)
on conflict(key) do nothing;
