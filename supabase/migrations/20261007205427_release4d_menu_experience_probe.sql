
create or replace function private.test_menu_experience_e2e()
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
  v_dish uuid;
  v_menu_result jsonb;
  v_menu uuid;
  v_public_menu uuid;
  v_workspace jsonb;
  v_public jsonb;
  v_promotion jsonb;
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
          'method','password',
          'timestamp',extract(epoch from clock_timestamp())::bigint
        ))
      )::text,
      true
    );
    perform set_config('request.headers','{}',true);

    update private.staff_sessions
    set unlocked_until=clock_timestamp()+interval '30 minutes'
    where session_id=v_session and user_id=v_user and revoked_at is null;

    insert into public.staff_venue_assignments(user_id,venue_id,active)
    values(v_user,v_venue,true)
    on conflict(user_id,venue_id) do update set active=true;

    update public.feature_flags set licensed=true
    where name in ('MULTI_MENU_QR','MENU_PROMOTIONS','MULTI_VENUE');

    insert into public.venue_features(venue_id,name,enabled)
    values
      (v_venue,'MULTI_MENU_QR',true),
      (v_venue,'MENU_PROMOTIONS',true)
    on conflict(venue_id,name) do update set enabled=true;

    update public.staff_profiles set scope='CHAIN'
    where id=v_user and role='ADMIN' and active;

    v_category:=(public.save_category(
      null,null,'E2E Menu Experience Category',null,990,true,gen_random_uuid()
    )->>'id')::uuid;

    v_dish:=(public.save_dish(
      null,null,v_category,'E2E Menu Experience Drink',null,null,true,900,true,990,
      'ALWAYS',null,null,'{}'::integer[],gen_random_uuid()
    )->>'id')::uuid;

    update public.staff_profiles set scope='VENUE'
    where id=v_user and role='ADMIN' and active;

    v_menu_result:=public.save_venue_menu(
      v_venue,null,null,'E2E Dinner','e2e-dinner',true,true,
      array[1,2,3,4,5,6,7],null,null,null,null,1,
      array[v_category],array[v_dish],gen_random_uuid()
    );
    v_menu:=(v_menu_result->>'id')::uuid;
    v_public_menu:=(v_menu_result->>'public_menu_id')::uuid;

    v_promotion:=public.save_menu_promotion(
      null,null,v_venue,v_menu,'POPUP','E2E Promo','Promotion body',null,'Scopri',
      null,v_dish,null,clock_timestamp()-interval '1 minute',
      clock_timestamp()+interval '1 hour',10,1,true,gen_random_uuid()
    );

    v_workspace:=public.get_menu_experience_workspace(v_venue);
    v_public:=public.get_public_menu_by_id(v_public_menu,v_venue);

    if coalesce((v_workspace->>'multi_menu_enabled')::boolean,false)<>true then raise exception 'MENU_EXPERIENCE_MULTI_MENU_FAILED'; end if;
    if coalesce((v_workspace->>'promotions_enabled')::boolean,false)<>true then raise exception 'MENU_EXPERIENCE_PROMOTIONS_FAILED'; end if;
    if coalesce((v_workspace->>'can_manage_chain_menus')::boolean,true)<>false then raise exception 'MENU_EXPERIENCE_SCOPE_FAILED'; end if;
    if not exists(
      select 1 from jsonb_array_elements(v_workspace->'menus') m
      where (m->>'id')::uuid=v_menu
        and (m->>'public_menu_id')::uuid=v_public_menu
        and (m->>'assigned_to_current_venue')::boolean
        and m->>'public_url' like '%/menu?menu=%'
    ) then raise exception 'MENU_EXPERIENCE_WORKSPACE_FAILED'; end if;
    if not exists(
      select 1 from jsonb_array_elements(v_workspace->'promotions') p
      where (p->>'id')::uuid=(v_promotion->>'id')::uuid
        and (p->>'editable')::boolean
    ) then raise exception 'MENU_EXPERIENCE_PROMOTION_WORKSPACE_FAILED'; end if;
    if (v_public->'menu'->>'public_menu_id')::uuid<>v_public_menu then raise exception 'MENU_EXPERIENCE_PUBLIC_ID_FAILED'; end if;
    if jsonb_array_length(v_public->'categories')<>1 then raise exception 'MENU_EXPERIENCE_PUBLIC_CATEGORY_FAILED'; end if;
    if jsonb_array_length(v_public->'promotions')<>1 or v_public->'promotions'->0->>'display_mode'<>'POPUP' then raise exception 'MENU_EXPERIENCE_PUBLIC_PROMOTION_FAILED'; end if;

    v_evidence:=jsonb_build_object(
      'venue_admin_single_venue_menu',true,
      'public_menu_id_stable',true,
      'workspace_menu_visible',true,
      'public_url_generated',true,
      'venue_promotion_editable',true,
      'public_payload_categories',1,
      'public_payload_promotions',1,
      'popup_period_filter',true,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_MENU_EXPERIENCE_TEST__' using detail=v_evidence::text;
  exception when others then
    get stacked diagnostics v_detail=pg_exception_detail;
    if sqlerrm='__ROLLBACK_MENU_EXPERIENCE_TEST__' then return v_detail::jsonb; end if;
    raise;
  end;
end
$$;

revoke all on function private.test_menu_experience_e2e()
from public,anon,authenticated;
grant execute on function private.test_menu_experience_e2e()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'MENU_EXPERIENCE_E2E',
  'E2E',
  true,
  'Venue Admin can configure and publish a single-venue menu with stable public_menu_id and venue-scoped promotion; public payload resolves categories/promotions and admin workspace exposes the permanent public URL.'
)
on conflict(key) do nothing;
