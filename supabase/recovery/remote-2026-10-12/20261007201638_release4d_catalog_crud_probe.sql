
create or replace function private.test_catalog_authoritative_crud()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='d05b9ce5-1049-4622-bb49-35ebef2c777a'::uuid;
  v_session constant uuid:='15e44a65-d47e-42f8-a5bf-77dd13c6540e'::uuid;
  v_venue constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_category uuid;
  v_ingredient uuid;
  v_station uuid;
  v_dish uuid;
  v_version bigint;
  v_history jsonb;
  v_category_error text;
  v_station_error text;
  v_detail text;
  v_evidence jsonb;
begin
  begin
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub',v_user::text,'session_id',v_session::text,
        'iat',extract(epoch from clock_timestamp())::bigint,
        'aal','aal2','role','authenticated',
        'amr',jsonb_build_array(jsonb_build_object(
          'method','password','timestamp',extract(epoch from clock_timestamp())::bigint
        ))
      )::text,
      true
    );
    perform set_config('request.headers','{}',true);

    update private.staff_sessions
    set unlocked_until=clock_timestamp()+interval '30 minutes'
    where session_id=v_session and user_id=v_user and revoked_at is null;

    update public.staff_profiles
    set scope='CHAIN'
    where id=v_user and role='ADMIN' and active;

    if private.current_role() is distinct from 'ADMIN'::public.user_role
       or not private.can_manage_shared_catalog()
    then raise exception 'CATALOG_TEST_AUTH_FAILED'; end if;

    v_category:=(public.save_category(
      null,null,'E2E Categoria Catalogo','Categoria probe',999,true,gen_random_uuid()
    )->>'id')::uuid;

    v_ingredient:=(public.save_ingredient(
      null,null,'E2E Ingrediente Catalogo',true,'{}'::uuid[],gen_random_uuid()
    )->>'id')::uuid;

    v_station:=(public.save_station(
      v_venue,null,null,'E2E Stazione Catalogo',true,gen_random_uuid()
    )->>'id')::uuid;

    v_dish:=(public.save_dish(
      null,null,v_category,'E2E Piatto Catalogo','Piatto probe',null,false,1000,false,999,
      'ALWAYS',null,null,'{}'::integer[],gen_random_uuid()
    )->>'id')::uuid;

    select version into v_version from public.dishes where id=v_dish;

    perform public.save_dish_composition(
      v_dish,v_version,
      jsonb_build_array(jsonb_build_object('ingredient_id',v_ingredient,'removable',true)),
      '{}'::uuid[],'[]'::jsonb,gen_random_uuid()
    );

    select version into v_version from public.dishes where id=v_dish;

    perform public.save_dish(
      v_dish,v_version,v_category,'E2E Piatto Catalogo','Piatto probe',null,false,1200,true,999,
      'ALWAYS',null,null,'{}'::integer[],gen_random_uuid()
    );

    perform public.save_venue_dish(
      v_venue,v_dish,null,true,1300,5,v_station,'{}'::uuid[],gen_random_uuid()
    );

    v_history:=public.get_dish_price_history(v_dish,v_venue);

    if jsonb_array_length(v_history)<>3
       or not exists(
         select 1 from jsonb_array_elements(v_history) h
         where h->>'source'='BASE' and (h->>'new_price_cents')::bigint=1000
       )
       or not exists(
         select 1 from jsonb_array_elements(v_history) h
         where h->>'source'='BASE' and (h->>'new_price_cents')::bigint=1200
       )
       or not exists(
         select 1 from jsonb_array_elements(v_history) h
         where h->>'source'='VENUE' and (h->>'new_price_cents')::bigint=1300
       )
    then raise exception 'CATALOG_PRICE_HISTORY_FAILED'; end if;

    begin
      perform public.save_category(
        v_category,(select version from public.categories where id=v_category),
        'E2E Categoria Catalogo','Categoria probe',999,false,gen_random_uuid()
      );
      v_category_error:='NO_ERROR';
    exception when others then
      v_category_error:=sqlerrm;
    end;

    begin
      perform public.save_station(
        v_venue,v_station,(select version from public.stations where id=v_station),
        'E2E Stazione Catalogo',false,gen_random_uuid()
      );
      v_station_error:='NO_ERROR';
    exception when others then
      v_station_error:=sqlerrm;
    end;

    if v_category_error<>'CATEGORY_IN_USE' or v_station_error<>'STATION_IN_USE' then
      raise exception 'CATALOG_ARCHIVE_GUARD_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'category_created',true,
      'ingredient_created',true,
      'station_created',true,
      'dish_created_as_draft',true,
      'composition_saved',true,
      'dish_activated_after_composition',true,
      'venue_override_saved',true,
      'price_history_rows',jsonb_array_length(v_history),
      'base_price_history',true,
      'venue_price_history',true,
      'category_in_use_guard',v_category_error,
      'station_in_use_guard',v_station_error,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_CATALOG_CRUD_TEST__' using detail=v_evidence::text;
  exception when others then
    get stacked diagnostics v_detail=pg_exception_detail;
    if sqlerrm='__ROLLBACK_CATALOG_CRUD_TEST__' then return v_detail::jsonb; end if;
    raise;
  end;
end
$$;

revoke all on function private.test_catalog_authoritative_crud()
from public,anon,authenticated;
grant execute on function private.test_catalog_authoritative_crud()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'CATALOG_AUTHORITATIVE_CRUD',
  'REGRESSION',
  true,
  'Authoritative category/ingredient/station/dish CRUD supports draft→composition→activation, venue override, immutable base/local price history and in-use archive guards.'
)
on conflict(key) do nothing;
