begin;

create table private.customer_access_backoff (
  bucket text primary key check(bucket ~ '^[a-f0-9]{64}$'),
  failures integer not null default 0 check(failures between 0 and 1000),
  blocked_until timestamptz,
  last_attempt_at timestamptz not null default clock_timestamp()
);
alter table private.customer_access_backoff enable row level security;
revoke all on private.customer_access_backoff from public,anon,authenticated,service_role;

create function public.check_customer_access_backoff(p_bucket text) returns integer
language plpgsql security definer set search_path='' as $$
declare remaining integer;
begin
  if p_bucket is null or p_bucket !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_RATE_BUCKET'; end if;
  select greatest(0,ceil(extract(epoch from blocked_until-clock_timestamp()))::integer)
    into remaining from private.customer_access_backoff where bucket=p_bucket;
  return coalesce(remaining,0);
end $$;
revoke all on function public.check_customer_access_backoff(text) from public,anon,authenticated,service_role;
grant execute on function public.check_customer_access_backoff(text) to service_role;

create function public.record_customer_access_failure(p_bucket text) returns integer
language plpgsql security definer set search_path='' as $$
declare count_now integer; seconds integer;
begin
  if p_bucket is null or p_bucket !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_RATE_BUCKET'; end if;
  insert into private.customer_access_backoff(bucket,failures,blocked_until,last_attempt_at)
  values(p_bucket,1,null,clock_timestamp())
  on conflict(bucket) do update set
    failures=case when private.customer_access_backoff.last_attempt_at<clock_timestamp()-interval '15 minutes'
      then 1 else least(private.customer_access_backoff.failures+1,1000) end,
    last_attempt_at=clock_timestamp(),
    blocked_until=null
  returning failures into count_now;
  seconds:=case when count_now<=3 then 0 else least(900,(power(2,least(count_now-3,10)))::integer) end;
  if seconds>0 then
    update private.customer_access_backoff
       set blocked_until=clock_timestamp()+make_interval(secs=>seconds)
     where bucket=p_bucket;
  end if;
  return seconds;
end $$;
revoke all on function public.record_customer_access_failure(text) from public,anon,authenticated,service_role;
grant execute on function public.record_customer_access_failure(text) to service_role;

create function public.clear_customer_access_backoff(p_bucket text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_bucket is null or p_bucket !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_RATE_BUCKET'; end if;
  delete from private.customer_access_backoff where bucket=p_bucket;
end $$;
revoke all on function public.clear_customer_access_backoff(text) from public,anon,authenticated,service_role;
grant execute on function public.clear_customer_access_backoff(text) to service_role;

create or replace function public.get_customer_account(p_public_table uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.accounts; settings public.venue_settings; venue public.venues;
begin
  select account.* into a from public.accounts account join public.tables t on t.id=account.table_id
    where t.public_table_id=p_public_table and private.owns_customer_account(account.id)
    order by account.created_at desc limit 1;
  if a.id is null then raise exception 'CUSTOMER_SESSION_REQUIRED' using errcode='42501'; end if;
  select * into settings from public.venue_settings where venue_id=a.venue_id;
  select * into venue from public.venues where id=a.venue_id;
  return jsonb_build_object(
    'id',a.id,'name',a.account_name,'covers',a.covers,'venue_id',a.venue_id,
    'currency',venue.currency,'locale',venue.locale,
    'balance',private.account_balance(a.id),
    'customer_ordering',case when exists(select 1 from public.feature_flags where name='CLIENT_ORDERING' and licensed)
      then settings.customer_ordering else 'DISABLED' end,
    'bill_request_enabled',settings.customer_bill_request,
    'items',coalesce((
      select jsonb_agg(to_jsonb(row) order by row.ordered_at,row.name) from (
        select i.id,i.dish_name name,count(*)::integer quantity,i.unit_price_cents,o.created_at ordered_at,
          coalesce((select jsonb_agg(r.ingredient_name order by r.ingredient_name)
            from public.order_item_removed_ingredients r where r.order_item_id=i.id),'[]') removed_ingredients,
          coalesce((select jsonb_agg(jsonb_build_object('group',v.group_name,'option',v.option_name) order by v.group_name,v.option_name)
            from public.order_item_variants v where v.order_item_id=i.id),'[]') variants
        from public.billing_units u
        join public.order_items i on i.id=u.order_item_id
        join public.orders o on o.id=i.order_id
        where u.account_id=a.id and u.voided_at is null
        group by i.id,o.created_at
      ) row
    ),'[]'),
    'requests',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'status',r.status,'reason',r.reason,'created_at',r.created_at,'resolved_at',r.resolved_at
    ) order by r.created_at desc) from public.customer_order_requests r where r.account_id=a.id),'[]')
  );
end $$;

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
        where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
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

create or replace function public.resolve_customer_order(p_request uuid,p_approve boolean,p_reason text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare request public.customer_order_requests; a public.accounts; ref uuid; final_status text;
begin
  select * into request from public.customer_order_requests where id=p_request for update;
  if request.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(request.venue_id,array['WAITER']::public.user_role[]);
  select * into a from public.accounts where id=request.account_id for update;
  if private.responsible_waiter(a.table_id) is distinct from private.effective_user_id() then
    raise exception 'RESPONSIBLE_WAITER_REQUIRED' using errcode='42501';
  end if;
  if request.status<>'PENDING' then return jsonb_build_object('status',request.status,'order_id',request.order_id); end if;
  if p_approve then ref:=private.place_order(a.id,request.payload,'CUSTOMER'); end if;
  final_status:=case when p_approve then 'APPROVED' else 'REJECTED' end;
  update public.customer_order_requests
     set status=final_status,order_id=ref,reason=nullif(trim(p_reason),''),resolved_at=clock_timestamp()
   where id=p_request;
  update public.notifications
     set status='RESOLVED',acknowledged_at=coalesce(acknowledged_at,clock_timestamp()),resolved_at=clock_timestamp()
   where resource_type='customer_order_requests' and resource_id=p_request and status<>'RESOLVED';
  return jsonb_build_object('status',final_status,'order_id',ref);
end $$;

create function public.get_customer_order_approval_workspace(p_venue uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize(p_venue,array['WAITER']::public.user_role[],false);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',r.id,'account_id',a.id,'account_name',a.account_name,'table_id',t.id,'table_name',t.name,
      'table_number',t.number,'created_at',r.created_at,
      'items',coalesce((
        select jsonb_agg(jsonb_build_object(
          'dish_id',(line->>'dish_id')::uuid,
          'name',coalesce(d.name,'Piatto non più disponibile'),
          'quantity',(line->>'quantity')::integer,
          'step',coalesce((line->>'step')::integer,1),
          'removed_ingredients',coalesce((select jsonb_agg(i.name order by i.name)
            from jsonb_array_elements_text(coalesce(line->'removed_ingredients','[]'::jsonb)) x
            join public.ingredients i on i.id=x::uuid),'[]'),
          'variants',coalesce((select jsonb_agg(jsonb_build_object('group',g.name,'option',o.label) order by g.name,o.label)
            from jsonb_array_elements_text(coalesce(line->'variant_options','[]'::jsonb)) x
            join public.variant_options o on o.id=x::uuid join public.variant_groups g on g.id=o.group_id),'[]')
        ) order by ordinality)
        from jsonb_array_elements(r.payload) with ordinality payload(line,ordinality)
        left join public.dishes d on d.id=(line->>'dish_id')::uuid
      ),'[]')
    ) order by r.created_at)
    from public.customer_order_requests r
    join public.accounts a on a.id=r.account_id
    join public.tables t on t.id=a.table_id
    where r.venue_id=p_venue and r.status='PENDING'
      and private.responsible_waiter(a.table_id)=private.effective_user_id()
  ),'[]');
end $$;
revoke all on function public.get_customer_order_approval_workspace(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_customer_order_approval_workspace(uuid) to authenticated;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.check_customer_access_backoff(text)','service_role'),
  ('public.record_customer_access_failure(text)','service_role'),
  ('public.clear_customer_access_backoff(text)','service_role'),
  ('public.get_customer_order_approval_workspace(uuid)','authenticated')
on conflict do nothing;

notify pgrst,'reload schema';
commit;