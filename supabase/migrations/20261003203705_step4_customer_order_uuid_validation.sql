begin;
create or replace function public.create_customer_order_request(p_account uuid,p_items jsonb,p_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.accounts; mode text; result jsonb; ref uuid; waiter uuid; line jsonb; raw text; qty_text text; step_text text;
begin
  if not private.owns_customer_account(p_account) then raise exception 'CUSTOMER_SESSION_REQUIRED' using errcode='42501'; end if;
  select * into a from public.accounts where id=p_account for update;
  select customer_ordering into mode from public.venue_settings where venue_id=a.venue_id;
  if not exists(select 1 from public.feature_flags where name='CLIENT_ORDERING' and licensed) or mode='DISABLED' then raise exception 'ORDERING_DISABLED'; end if;
  if a.status not in ('OPEN','BILL_REQUESTED') then raise exception 'ACCOUNT_NOT_ORDERABLE'; end if;
  raw:=p_items::text;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 or octet_length(raw)>32768 then raise exception 'INVALID_ITEMS'; end if;
  for line in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(line)<>'object'
      or exists(select 1 from jsonb_object_keys(line) k where k not in ('dish_id','quantity','step','removed_ingredients','variant_options'))
      or not (line ? 'dish_id') or not (line ? 'quantity')
      or (line->>'dish_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(coalesce(line->'removed_ingredients','[]'::jsonb))<>'array'
      or jsonb_typeof(coalesce(line->'variant_options','[]'::jsonb))<>'array'
      or jsonb_array_length(coalesce(line->'removed_ingredients','[]'::jsonb))>100
      or jsonb_array_length(coalesce(line->'variant_options','[]'::jsonb))>100
      or exists(select 1 from jsonb_array_elements_text(coalesce(line->'removed_ingredients','[]'::jsonb)) x
        where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      or exists(select 1 from jsonb_array_elements_text(coalesce(line->'variant_options','[]'::jsonb)) x
        where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    then raise exception 'INVALID_ITEM_FIELDS'; end if;
    qty_text:=line->>'quantity'; step_text:=coalesce(line->>'step','1');
    if qty_text !~ '^[0-9]{1,3}$' or step_text !~ '^[0-9]{1,2}$'
      or qty_text::integer not between 1 and 999 or step_text::integer not between 1 and 99
    then raise exception 'INVALID_QUANTITY_OR_STEP'; end if;
  end loop;
  result:=private.idempotency_begin('customer_order',p_key,jsonb_build_object('account',p_account,'items',p_items));
  if result is not null then return result; end if;
  if mode='DIRECT' then
    ref:=private.place_order(p_account,p_items,'CUSTOMER');
    result:=jsonb_build_object('order_id',ref,'status','APPROVED');
  else
    insert into public.customer_order_requests(venue_id,account_id,requested_by,payload)
      values(a.venue_id,a.id,auth.uid(),p_items) returning id into ref;
    waiter:=private.responsible_waiter(a.table_id);
    insert into public.notifications(venue_id,recipient_user_id,recipient_role,category,title,resource_type,resource_id)
      values(a.venue_id,waiter,case when waiter is null then 'ADMIN'::public.user_role end,
        'ORDER_APPROVAL','Richiesta ordine da verificare','customer_order_requests',ref);
    result:=jsonb_build_object('request_id',ref,'status','PENDING');
  end if;
  return private.idempotency_finish('customer_order',p_key,result);
end $$;
commit;