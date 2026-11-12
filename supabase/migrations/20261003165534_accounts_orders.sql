begin;
alter table private.customer_access_codes drop column lookup_hash;
alter table public.order_steps add constraint order_step_parent unique(venue_id,order_id,id);
alter table public.order_items add constraint item_step_parent foreign key(venue_id,order_id,step_id) references public.order_steps(venue_id,order_id,id);

create function private.random_account_code() returns text language plpgsql volatile security definer set search_path='' as $$
declare bytes bytea; value bigint;
begin
  loop
    bytes:=extensions.gen_random_bytes(4);
    value:=get_byte(bytes,0)::bigint*16777216+get_byte(bytes,1)::bigint*65536+get_byte(bytes,2)::bigint*256+get_byte(bytes,3);
    exit when value<4294000000;
  end loop;
  return lpad((value%1000000)::text,6,'0');
end $$;
create function private.rotate_code(p_account uuid) returns text language plpgsql security definer set search_path='' as $$
declare code text; table_ref uuid;
begin
  select table_id into table_ref from public.accounts where id=p_account for update;
  loop
    code:=private.random_account_code();
    exit when not exists(select 1 from private.customer_access_codes c join public.accounts a on a.id=c.account_id
      where a.table_id=table_ref and a.status<>'CLOSED' and c.expires_at>now() and extensions.crypt(code,c.code_hash)=c.code_hash);
  end loop;
  insert into private.customer_access_codes(account_id,code_hash,expires_at) values(p_account,extensions.crypt(code,extensions.gen_salt('bf',10)),now()+interval '18 hours')
    on conflict(account_id) do update set code_hash=excluded.code_hash,expires_at=excluded.expires_at,created_at=now();
  update public.accounts set access_epoch=access_epoch+1 where id=p_account;
  update private.customer_sessions set revoked_at=now() where account_id=p_account and revoked_at is null;
  perform private.audit('ACCOUNT_CODE_ROTATED','accounts',p_account,(select venue_id from public.accounts where id=p_account));
  return code;
end $$;
create function public.create_account(p_table uuid,p_name text,p_covers integer,p_note text,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.tables; account_id uuid; result jsonb; code text;
begin
  select * into t from public.tables where id=p_table and active for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(t.venue_id,array['WAITER']::public.user_role[]);
  if private.responsible_waiter(t.id) is distinct from private.effective_user_id() then raise exception 'RESPONSIBLE_WAITER_REQUIRED' using errcode='42501'; end if;
  result:=private.idempotency_begin('create_account',p_key,jsonb_build_object('table',p_table,'name',p_name,'covers',p_covers,'note',p_note));
  if result is not null then return result; end if;
  if t.technical_status='TO_RESET' then raise exception 'TABLE_NEEDS_RESET'; end if;
  insert into public.accounts(venue_id,table_id,account_name,covers,internal_note,created_by)
    values(t.venue_id,t.id,p_name,p_covers,p_note,private.effective_user_id()) returning id into account_id;
  update public.tables set technical_status='OCCUPIED' where id=t.id;
  code:=private.rotate_code(account_id);
  perform private.idempotency_finish('create_account',p_key,jsonb_build_object('id',account_id,'code_available',false));
  return jsonb_build_object('id',account_id,'code',code,'code_available',true);
end $$;
create function public.regenerate_account_code(p_account uuid) returns text language plpgsql security definer set search_path='' as $$
declare a public.accounts;
begin
  select * into a from public.accounts where id=p_account for update;
  perform private.authorize(a.venue_id,array['WAITER']::public.user_role[]);
  if a.id is null or a.status='CLOSED' or private.responsible_waiter(a.table_id) is distinct from private.effective_user_id() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  return private.rotate_code(a.id);
end $$;

create function private.place_order(p_account uuid,p_items jsonb,p_origin text) returns uuid language plpgsql security definer set search_path='' as $$
declare a public.accounts; v public.venues; line jsonb; d public.dishes; setting public.venue_dish_settings;
  order_ref uuid; step_ref uuid; item_ref uuid; station_ref uuid; step_no integer; qty integer;
  removed uuid[]; variants uuid[]; selection record; price bigint; ingredient_data jsonb; allergen_data jsonb;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null or a.status not in ('OPEN','BILL_REQUESTED') then raise exception 'ACCOUNT_NOT_ORDERABLE'; end if;
  select * into v from public.venues where id=a.venue_id and active and operational_status='OPEN';
  if not found or not private.installation_active() then raise exception 'OPERATIONS_UNAVAILABLE'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'INVALID_ITEMS'; end if;
  -- Global sorted dish locks serialize price changes and stock consumption without deadlock.
  perform 1 from public.dishes where id in (select (value->>'dish_id')::uuid from jsonb_array_elements(p_items)) order by id for update;
  insert into public.orders(venue_id,account_id,origin,created_by) values(a.venue_id,a.id,p_origin,auth.uid()) returning id into order_ref;
  for line in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(line)<>'object' or exists(select 1 from jsonb_object_keys(line) k where k not in ('dish_id','quantity','step','removed_ingredients','variant_options')) then raise exception 'INVALID_ITEM_FIELDS'; end if;
    qty:=(line->>'quantity')::integer; step_no:=coalesce((line->>'step')::integer,1);
    if qty is null or qty not between 1 and 999 or step_no not between 1 and 99 then raise exception 'INVALID_QUANTITY_OR_STEP'; end if;
    select * into d from public.dishes where id=(line->>'dish_id')::uuid and active;
    if d.id is null or not exists(select 1 from public.categories where id=d.category_id and active) then raise exception 'DISH_UNAVAILABLE'; end if;
    if not (d.schedule_mode='ALWAYS' or (d.schedule_mode='DATE' and d.available_from=(now() at time zone v.timezone)::date)
      or (d.schedule_mode='WEEKDAYS' and extract(isodow from now() at time zone v.timezone)::integer=any(d.weekdays))
      or (d.schedule_mode='RANGE' and (now() at time zone v.timezone)::date between d.available_from and d.available_until)) then raise exception 'DISH_UNAVAILABLE'; end if;
    select * into setting from public.venue_dish_settings where venue_id=a.venue_id and dish_id=d.id for update;
    if setting.dish_id is not null and not setting.enabled then raise exception 'DISH_UNAVAILABLE'; end if;
    station_ref:=setting.local_station_id;
    if station_ref is null then select station_id into station_ref from public.dish_station_assignments where venue_id=a.venue_id and dish_id=d.id and is_primary; end if;
    if station_ref is null or not exists(select 1 from public.stations where id=station_ref and venue_id=a.venue_id and active) then raise exception 'STATION_REQUIRED'; end if;
    if setting.availability is not null then
      if setting.availability_date is distinct from (now() at time zone v.timezone)::date then raise exception 'AVAILABILITY_NOT_SET_TODAY'; end if;
      if setting.availability<qty then raise exception 'OUT_OF_STOCK' using errcode='P0001'; end if;
      update public.venue_dish_settings set availability=availability-qty where venue_id=a.venue_id and dish_id=d.id;
    end if;
    select coalesce(array_agg(x::uuid),'{}') into removed from jsonb_array_elements_text(coalesce(line->'removed_ingredients','[]')) x;
    select coalesce(array_agg(x::uuid),'{}') into variants from jsonb_array_elements_text(coalesce(line->'variant_options','[]')) x;
    if cardinality(removed)<>(select count(distinct x) from unnest(removed) x) or cardinality(variants)<>(select count(distinct x) from unnest(variants) x) then raise exception 'DUPLICATE_SELECTION'; end if;
    if exists(select 1 from unnest(removed) x where not exists(select 1 from public.dish_ingredients where dish_id=d.id and ingredient_id=x and removable)) then raise exception 'INGREDIENT_NOT_REMOVABLE'; end if;
    if not d.beverage and not exists(select 1 from public.dish_ingredients where dish_id=d.id) then raise exception 'INGREDIENTS_REQUIRED'; end if;
    if exists(select 1 from unnest(variants) x where not exists(select 1 from public.variant_options o join public.variant_groups g on g.id=o.group_id where o.id=x and o.active and g.active and g.dish_id=d.id)) then raise exception 'INVALID_VARIANT'; end if;
    for selection in select g.id,g.required,g.max_selections,(select count(*) from public.variant_options o where o.group_id=g.id and o.id=any(variants)) as selected from public.variant_groups g where g.dish_id=d.id and g.active loop
      if (selection.required and selection.selected=0) or selection.selected>selection.max_selections then raise exception 'VARIANT_SELECTION_REQUIRED'; end if;
    end loop;
    price:=coalesce(setting.local_price_cents,d.price_cents);
    select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.name)),'[]') into ingredient_data from public.ingredients i join public.dish_ingredients di on di.ingredient_id=i.id where di.dish_id=d.id and not i.id=any(removed);
    select coalesce(jsonb_agg(jsonb_build_object('code',al.code,'name',al.name)),'[]') into allergen_data from public.allergens al where al.id in
      (select ia.allergen_id from public.ingredient_allergens ia join public.dish_ingredients di on di.ingredient_id=ia.ingredient_id where di.dish_id=d.id and not di.ingredient_id=any(removed));
    insert into public.order_steps(venue_id,order_id,step_number,status,started_at) values(a.venue_id,order_ref,step_no,case when step_no=1 then 'ACTIVE'::public.step_status else 'WAITING'::public.step_status end,case when step_no=1 then now() end)
      on conflict(order_id,step_number) do update set step_number=excluded.step_number returning id into step_ref;
    insert into public.order_items(venue_id,order_id,step_id,dish_id,station_id,quantity,unit_price_cents,dish_name,category_name,ingredient_snapshot,allergen_snapshot)
      values(a.venue_id,order_ref,step_ref,d.id,station_ref,qty,price,d.name,(select name from public.categories where id=d.category_id),ingredient_data,allergen_data) returning id into item_ref;
    insert into public.order_item_removed_ingredients(venue_id,order_item_id,ingredient_id,ingredient_name) select a.venue_id,item_ref,i.id,i.name from public.ingredients i where i.id=any(removed);
    insert into public.order_item_variants(venue_id,order_item_id,option_id,group_name,option_name) select a.venue_id,item_ref,o.id,g.name,o.label from public.variant_options o join public.variant_groups g on g.id=o.group_id where o.id=any(variants);
  end loop;
  if not exists(select 1 from public.order_steps where order_id=order_ref and step_number=1) then raise exception 'FIRST_STEP_REQUIRED'; end if;
  update public.accounts set status='OPEN' where id=a.id;
  update public.tables set technical_status='WAITING_SERVICE' where id=a.table_id;
  if p_origin='CUSTOMER' then
    insert into public.notifications(venue_id,recipient_user_id,recipient_role,category,title,resource_type,resource_id)
      values(a.venue_id,private.responsible_waiter(a.table_id),case when private.responsible_waiter(a.table_id) is null then 'ADMIN'::public.user_role end,'NEW_ORDER','Nuovo ordine cliente','orders',order_ref);
  end if;
  return order_ref;
end $$;

create function public.create_order(p_account uuid,p_items jsonb,p_key uuid,p_version bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.accounts; result jsonb; order_ref uuid;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['WAITER']::public.user_role[]);
  if private.responsible_waiter(a.table_id) is distinct from private.effective_user_id() then raise exception 'RESPONSIBLE_WAITER_REQUIRED' using errcode='42501'; end if;
  result:=private.idempotency_begin('create_order',p_key,jsonb_build_object('account',p_account,'items',p_items,'version',p_version));
  if result is not null then return result; end if;
  if a.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  order_ref:=private.place_order(p_account,p_items,'WAITER');
  return private.idempotency_finish('create_order',p_key,jsonb_build_object('id',order_ref));
end $$;

create function public.create_customer_order_request(p_account uuid,p_items jsonb,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.accounts; mode text; result jsonb; ref uuid; waiter uuid;
begin
  if not private.owns_customer_account(p_account) then raise exception 'CUSTOMER_SESSION_REQUIRED' using errcode='42501'; end if;
  select * into a from public.accounts where id=p_account for update;
  select customer_ordering into mode from public.venue_settings where venue_id=a.venue_id;
  if not exists(select 1 from public.feature_flags where name='CLIENT_ORDERING' and licensed) or mode='DISABLED' then raise exception 'ORDERING_DISABLED'; end if;
  if a.status not in ('OPEN','BILL_REQUESTED') then raise exception 'ACCOUNT_NOT_ORDERABLE'; end if;
  result:=private.idempotency_begin('customer_order',p_key,jsonb_build_object('account',p_account,'items',p_items));
  if result is not null then return result; end if;
  if mode='DIRECT' then
    ref:=private.place_order(p_account,p_items,'CUSTOMER'); result:=jsonb_build_object('order_id',ref,'status','APPROVED');
  else
    if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'INVALID_ITEMS'; end if;
    insert into public.customer_order_requests(venue_id,account_id,requested_by,payload) values(a.venue_id,a.id,auth.uid(),p_items) returning id into ref;
    waiter:=private.responsible_waiter(a.table_id);
    insert into public.notifications(venue_id,recipient_user_id,recipient_role,category,title,resource_type,resource_id)
      values(a.venue_id,waiter,case when waiter is null then 'ADMIN'::public.user_role end,'ORDER_APPROVAL','Richiesta ordine da verificare','customer_order_requests',ref);
    result:=jsonb_build_object('request_id',ref,'status','PENDING');
  end if;
  return private.idempotency_finish('customer_order',p_key,result);
end $$;

create function public.resolve_customer_order(p_request uuid,p_approve boolean,p_reason text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare request public.customer_order_requests; a public.accounts; ref uuid;
begin
  select * into request from public.customer_order_requests where id=p_request for update;
  if request.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(request.venue_id,array['WAITER']::public.user_role[]);
  select * into a from public.accounts where id=request.account_id for update;
  if private.responsible_waiter(a.table_id) is distinct from private.effective_user_id() then raise exception 'RESPONSIBLE_WAITER_REQUIRED' using errcode='42501'; end if;
  if request.status<>'PENDING' then return jsonb_build_object('status',request.status,'order_id',request.order_id); end if;
  if p_approve then ref:=private.place_order(a.id,request.payload,'CUSTOMER'); end if;
  update public.customer_order_requests set status=case when p_approve then 'APPROVED' else 'REJECTED' end,order_id=ref,reason=p_reason,resolved_at=now() where id=p_request;
  return jsonb_build_object('status',case when p_approve then 'APPROVED' else 'REJECTED' end,'order_id',ref);
end $$;
grant execute on function public.create_account(uuid,text,integer,text,uuid),public.regenerate_account_code(uuid),public.create_order(uuid,jsonb,uuid,bigint),
  public.create_customer_order_request(uuid,jsonb,uuid),public.resolve_customer_order(uuid,boolean,text) to authenticated;
commit;
