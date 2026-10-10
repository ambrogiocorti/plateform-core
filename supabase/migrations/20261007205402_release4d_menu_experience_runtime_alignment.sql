
alter table public.dishes
  alter column description drop not null;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_public_booking_availability(uuid,uuid,date,integer)','authenticated')
on conflict do nothing;

create or replace function public.get_menu_experience_workspace(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_chain boolean:=false;
  v_public_base text;
begin
  if p_venue is null then raise exception 'VENUE_REQUIRED'; end if;
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[],false);
  v_chain:=private.can_manage_shared_catalog();

  select public_base_url into v_public_base
  from public.restaurant_profile
  where id;

  return jsonb_build_object(
    'viewer_user_id',v_actor,
    'can_manage_chain_menus',v_chain,
    'multi_menu_enabled',
      private.feature_licensed('MULTI_MENU_QR')
      and private.venue_feature_enabled(p_venue,'MULTI_MENU_QR'),
    'promotions_enabled',
      private.feature_licensed('MENU_PROMOTIONS')
      and private.venue_feature_enabled(p_venue,'MENU_PROMOTIONS'),
    'public_base_url',v_public_base,
    'venues',coalesce((
      select jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'code',v.code) order by v.name,v.id)
      from public.venues v
      where v.active and private.has_venue(v.id)
    ),'[]'::jsonb),
    'menus',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',m.id,'public_menu_id',m.public_menu_id,'name',m.name,'slug',m.slug,
          'active',m.active,'published',m.published,'weekdays',to_jsonb(m.weekdays),
          'starts_at',m.starts_at,'ends_at',m.ends_at,
          'available_from',m.available_from,'available_until',m.available_until,
          'sort_order',m.sort_order,'version',m.version,
          'venue_ids',coalesce((
            select jsonb_agg(mv.venue_id order by mv.sort_order,mv.venue_id)
            from public.menu_venues mv where mv.menu_id=m.id
          ),'[]'::jsonb),
          'category_ids',coalesce((
            select jsonb_agg(mc.category_id order by mc.sort_order,mc.category_id)
            from public.menu_categories mc where mc.menu_id=m.id
          ),'[]'::jsonb),
          'dish_ids',coalesce((
            select jsonb_agg(md.dish_id order by md.sort_order,md.dish_id)
            from public.menu_dishes md where md.menu_id=m.id
          ),'[]'::jsonb),
          'assigned_to_current_venue',exists(
            select 1 from public.menu_venues mv where mv.menu_id=m.id and mv.venue_id=p_venue
          ),
          'public_url',case
            when exists(select 1 from public.menu_venues mv where mv.menu_id=m.id and mv.venue_id=p_venue)
            then rtrim(v_public_base,'/')||'/menu?menu='||m.public_menu_id::text||'&venue='||p_venue::text
            else null
          end
        )
        order by m.sort_order,m.name,m.id
      )
      from public.menus m
      where v_chain
         or exists(select 1 from public.menu_venues mv where mv.menu_id=m.id and mv.venue_id=p_venue)
    ),'[]'::jsonb),
    'promotions',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',p.id,'venue_id',p.venue_id,'menu_id',p.menu_id,'display_mode',p.display_mode,
          'title',p.title,'body',p.body,'image_path',p.image_path,'cta_label',p.cta_label,
          'target_category_id',p.target_category_id,'target_dish_id',p.target_dish_id,
          'target_menu_id',p.target_menu_id,'start_at',p.start_at,'end_at',p.end_at,
          'priority',p.priority,'max_impressions_per_session',p.max_impressions_per_session,
          'active',p.active,'version',p.version,
          'editable',p.venue_id=p_venue or (p.venue_id is null and v_chain)
        )
        order by p.priority desc,p.start_at desc,p.id
      )
      from public.menu_promotions p
      where p.venue_id=p_venue or p.venue_id is null
    ),'[]'::jsonb)
  );
end
$$;

create or replace function public.save_venue_menu(
  p_venue uuid,
  p_id uuid,
  p_version bigint,
  p_name text,
  p_slug text,
  p_active boolean,
  p_published boolean,
  p_weekdays integer[],
  p_starts_at time,
  p_ends_at time,
  p_available_from date,
  p_available_until date,
  p_sort_order integer,
  p_categories uuid[],
  p_dishes uuid[],
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
  v_menu public.menus;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_slug text:=lower(trim(p_slug));
  v_name text:=trim(p_name);
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if not private.feature_licensed('MULTI_MENU_QR')
     or not private.venue_feature_enabled(p_venue,'MULTI_MENU_QR')
  then raise exception 'FEATURE_DISABLED'; end if;

  if p_key is null
     or v_name is null or length(v_name) not between 1 and 120
     or v_slug is null or length(v_slug) not between 2 and 80
     or v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or p_active is null or p_published is null
     or p_weekdays is null or cardinality(p_weekdays) not between 1 and 7
     or exists(select 1 from unnest(p_weekdays) d where d not between 1 and 7)
     or (select count(*) from unnest(p_weekdays) d)<>(select count(distinct d) from unnest(p_weekdays) d)
     or (p_starts_at is null)<>(p_ends_at is null)
     or (p_available_from is not null and p_available_until is not null and p_available_until<p_available_from)
     or p_sort_order is null
     or p_categories is null or p_dishes is null
     or array_position(p_categories,null) is not null
     or array_position(p_dishes,null) is not null
     or cardinality(p_categories)>500 or cardinality(p_dishes)>2000
  then raise exception 'INVALID_MENU'; end if;

  if (select count(*) from unnest(p_categories) x)<>(select count(distinct x) from unnest(p_categories) x)
     or (select count(*) from unnest(p_dishes) x)<>(select count(distinct x) from unnest(p_dishes) x)
  then raise exception 'DUPLICATE_MENU_REFERENCE'; end if;

  if p_published and (not p_active or cardinality(p_categories)=0 or cardinality(p_dishes)=0)
  then raise exception 'MENU_NOT_PUBLISHABLE'; end if;

  if exists(
    select 1 from unnest(p_categories) c(id)
    left join public.categories x on x.id=c.id and x.active
    where x.id is null
  ) then raise exception 'CATEGORY_NOT_FOUND'; end if;

  if exists(
    select 1 from unnest(p_dishes) d(id)
    left join public.dishes x on x.id=d.id
    where x.id is null
  ) then raise exception 'DISH_NOT_FOUND'; end if;

  if exists(
    select 1 from public.dishes d
    where d.id=any(p_dishes) and not (d.category_id=any(p_categories))
  ) then raise exception 'MENU_CATEGORY_REQUIRED'; end if;

  if p_published and exists(
    select 1 from public.dishes d where d.id=any(p_dishes) and not d.active
  ) then raise exception 'INACTIVE_DISH_IN_PUBLISHED_MENU'; end if;

  v_result:=private.idempotency_begin(
    'venue_menu_configuration',p_key,
    jsonb_build_object(
      'venue',p_venue,'id',p_id,'version',p_version,'name',v_name,'slug',v_slug,
      'active',p_active,'published',p_published,'weekdays',p_weekdays,
      'starts_at',p_starts_at,'ends_at',p_ends_at,'available_from',p_available_from,
      'available_until',p_available_until,'sort_order',p_sort_order,
      'categories',p_categories,'dishes',p_dishes
    )
  );
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.menus(
      id,name,slug,active,published,weekdays,starts_at,ends_at,
      available_from,available_until,sort_order
    ) values(
      v_id,v_name,v_slug,p_active,p_published,p_weekdays,p_starts_at,p_ends_at,
      p_available_from,p_available_until,p_sort_order
    )
    returning * into v_menu;
  else
    select * into v_menu from public.menus where id=p_id for update;
    if v_menu.id is null then raise exception 'NOT_FOUND'; end if;
    if p_version is null or v_menu.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;
    if exists(select 1 from public.menu_venues mv where mv.menu_id=p_id and mv.venue_id<>p_venue) then
      raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
    end if;

    update public.menus
    set name=v_name,slug=v_slug,active=p_active,published=p_published,
        weekdays=p_weekdays,starts_at=p_starts_at,ends_at=p_ends_at,
        available_from=p_available_from,available_until=p_available_until,sort_order=p_sort_order
    where id=p_id
    returning * into v_menu;
  end if;

  delete from public.menu_dishes where menu_id=v_id;
  delete from public.menu_categories where menu_id=v_id;
  delete from public.menu_venues where menu_id=v_id;

  insert into public.menu_venues(menu_id,venue_id,sort_order) values(v_id,p_venue,1);
  insert into public.menu_categories(menu_id,category_id,sort_order)
  select v_id,id,ord::integer from unnest(p_categories) with ordinality c(id,ord);
  insert into public.menu_dishes(menu_id,dish_id,sort_order)
  select v_id,id,ord::integer from unnest(p_dishes) with ordinality d(id,ord);

  select * into v_menu from public.menus where id=v_id;
  v_result:=jsonb_build_object(
    'id',v_menu.id,'public_menu_id',v_menu.public_menu_id,
    'version',v_menu.version,'slug',v_menu.slug,'published',v_menu.published
  );
  return private.idempotency_finish('venue_menu_configuration',p_key,v_result);
end
$$;

revoke all on function public.get_menu_experience_workspace(uuid) from public,anon;
revoke all on function public.save_venue_menu(uuid,uuid,bigint,text,text,boolean,boolean,integer[],time,time,date,date,integer,uuid[],uuid[],uuid) from public,anon;
grant execute on function public.get_menu_experience_workspace(uuid) to authenticated,service_role;
grant execute on function public.save_venue_menu(uuid,uuid,bigint,text,text,boolean,boolean,integer[],time,time,date,date,integer,uuid[],uuid[],uuid) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
('public.get_menu_experience_workspace(uuid)','authenticated'),
('public.save_venue_menu(uuid,uuid,bigint,text,text,boolean,boolean,integer[],time without time zone,time without time zone,date,date,integer,uuid[],uuid[],uuid)','authenticated')
on conflict do nothing;
