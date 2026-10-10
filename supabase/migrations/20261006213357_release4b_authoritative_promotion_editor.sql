
create or replace function public.save_menu_promotion(
  p_id uuid,
  p_version bigint,
  p_venue uuid,
  p_menu uuid,
  p_display_mode text,
  p_title text,
  p_body text,
  p_image_path text,
  p_cta_label text,
  p_target_category uuid,
  p_target_dish uuid,
  p_target_menu uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_priority integer,
  p_max_impressions integer,
  p_active boolean,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_result jsonb;
  v_row public.menu_promotions;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_mode text:=upper(trim(p_display_mode));
  v_title text:=trim(p_title);
begin
  if p_venue is null then
    v_actor:=private.authorize(null,array['ADMIN']::public.user_role[]);
    if not private.can_manage_shared_catalog() then
      raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
    end if;
  else
    v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  end if;

  if p_key is null
     or v_mode not in ('BANNER','CARD','BADGE','POPUP')
     or v_title is null
     or length(v_title) not between 1 and 160
     or (p_body is not null and length(p_body)>2000)
     or (p_image_path is not null and length(p_image_path)>500)
     or (p_cta_label is not null and length(trim(p_cta_label)) not between 1 and 80)
     or p_start_at is null
     or (p_end_at is not null and p_end_at<=p_start_at)
     or p_priority is null
     or p_priority not between -100000 and 100000
     or (p_max_impressions is not null and p_max_impressions not between 1 and 100)
     or p_active is null
     or num_nonnulls(p_target_category,p_target_dish,p_target_menu)>1
  then
    raise exception 'INVALID_PROMOTION';
  end if;

  if p_menu is not null then
    if not exists(select 1 from public.menus where id=p_menu) then
      raise exception 'MENU_NOT_FOUND';
    end if;

    if p_venue is not null and not exists(
      select 1 from public.menu_venues
      where menu_id=p_menu and venue_id=p_venue
    ) then
      raise exception 'MENU_VENUE_REQUIRED';
    end if;
  end if;

  if p_target_category is not null
     and not exists(select 1 from public.categories where id=p_target_category) then
    raise exception 'CATEGORY_NOT_FOUND';
  end if;

  if p_target_dish is not null
     and not exists(select 1 from public.dishes where id=p_target_dish) then
    raise exception 'DISH_NOT_FOUND';
  end if;

  if p_target_menu is not null
     and not exists(select 1 from public.menus where id=p_target_menu) then
    raise exception 'TARGET_MENU_NOT_FOUND';
  end if;

  if p_menu is not null
     and p_target_category is not null
     and not exists(
       select 1 from public.menu_categories
       where menu_id=p_menu and category_id=p_target_category
     ) then
    raise exception 'PROMOTION_TARGET_NOT_IN_MENU';
  end if;

  if p_menu is not null
     and p_target_dish is not null
     and not exists(
       select 1 from public.menu_dishes
       where menu_id=p_menu and dish_id=p_target_dish
     ) then
    raise exception 'PROMOTION_TARGET_NOT_IN_MENU';
  end if;

  if p_venue is not null
     and p_target_menu is not null
     and not exists(
       select 1 from public.menu_venues
       where menu_id=p_target_menu and venue_id=p_venue
     ) then
    raise exception 'TARGET_MENU_VENUE_REQUIRED';
  end if;

  v_result:=private.idempotency_begin(
    'menu_promotion',
    p_key,
    jsonb_build_object(
      'id',p_id,
      'version',p_version,
      'venue',p_venue,
      'menu',p_menu,
      'display_mode',v_mode,
      'title',v_title,
      'body',nullif(p_body,''),
      'image_path',nullif(p_image_path,''),
      'cta_label',nullif(trim(p_cta_label),''),
      'target_category',p_target_category,
      'target_dish',p_target_dish,
      'target_menu',p_target_menu,
      'start_at',p_start_at,
      'end_at',p_end_at,
      'priority',p_priority,
      'max_impressions',p_max_impressions,
      'active',p_active
    )
  );
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.menu_promotions(
      id,venue_id,menu_id,display_mode,title,body,image_path,cta_label,
      target_category_id,target_dish_id,target_menu_id,
      start_at,end_at,priority,max_impressions_per_session,active
    ) values(
      v_id,p_venue,p_menu,v_mode,v_title,nullif(p_body,''),nullif(p_image_path,''),
      nullif(trim(p_cta_label),''),
      p_target_category,p_target_dish,p_target_menu,
      p_start_at,p_end_at,p_priority,p_max_impressions,p_active
    )
    returning * into v_row;
  else
    select * into v_row
    from public.menu_promotions
    where id=p_id
    for update;

    if v_row.id is null then raise exception 'NOT_FOUND'; end if;

    if v_row.venue_id is distinct from p_venue then
      raise exception 'PROMOTION_SCOPE_IMMUTABLE';
    end if;

    if p_version is null or v_row.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    update public.menu_promotions
    set menu_id=p_menu,
        display_mode=v_mode,
        title=v_title,
        body=nullif(p_body,''),
        image_path=nullif(p_image_path,''),
        cta_label=nullif(trim(p_cta_label),''),
        target_category_id=p_target_category,
        target_dish_id=p_target_dish,
        target_menu_id=p_target_menu,
        start_at=p_start_at,
        end_at=p_end_at,
        priority=p_priority,
        max_impressions_per_session=p_max_impressions,
        active=p_active
    where id=p_id
    returning * into v_row;
  end if;

  v_result:=jsonb_build_object(
    'id',v_row.id,
    'version',v_row.version,
    'active',v_row.active,
    'start_at',v_row.start_at,
    'end_at',v_row.end_at
  );

  return private.idempotency_finish('menu_promotion',p_key,v_result);
end
$$;

revoke all on function public.save_menu_promotion(
  uuid,bigint,uuid,uuid,text,text,text,text,text,uuid,uuid,uuid,timestamptz,timestamptz,integer,integer,boolean,uuid
) from public,anon;

grant execute on function public.save_menu_promotion(
  uuid,bigint,uuid,uuid,text,text,text,text,text,uuid,uuid,uuid,timestamptz,timestamptz,integer,integer,boolean,uuid
) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values(
  'public.save_menu_promotion(uuid,bigint,uuid,uuid,text,text,text,text,text,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,integer,integer,boolean,uuid)',
  'authenticated'
)
on conflict do nothing;
