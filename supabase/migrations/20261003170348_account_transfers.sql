begin;
alter table public.accounts add column financial_partition boolean not null default false;
alter table public.accounts drop constraint accounts_covers_check;
alter table public.accounts add constraint account_cover_limits check(covers between 1 and 1000 or (financial_partition and covers=0));
create function public.move_account_items(p_source uuid,p_target uuid,p_name text,p_items jsonb,p_source_version bigint,p_target_version bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare source public.accounts; target public.accounts; previous jsonb; entry jsonb; unit record; qty integer; found_count integer; selected uuid[]:='{}'; ref uuid;
begin
  select * into source from public.accounts where id=p_source;
  if source.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(source.venue_id,array['ADMIN','CASHIER']::public.user_role[]);
  perform private.lock_floor(source.venue_id);
  perform 1 from public.accounts where id in(p_source,p_target) order by id for update;
  select * into source from public.accounts where id=p_source;
  previous:=private.idempotency_begin('move_account_items',p_key,jsonb_build_object('source',p_source,'target',p_target,'name',p_name,'items',p_items,'source_version',p_source_version,'target_version',p_target_version));
  if previous is not null then return previous; end if;
  if source.status='CLOSED' or source.floor_released_at is not null or source.version is distinct from p_source_version then raise exception 'VERSION_CONFLICT'; end if;
  if p_target is null then
    if p_name is null or length(trim(p_name)) not between 1 and 160 then raise exception 'INVALID_ACCOUNT_NAME'; end if;
    insert into public.accounts(venue_id,table_id,account_name,covers,financial_partition,created_by)
      values(source.venue_id,source.table_id,trim(p_name),0,true,private.effective_user_id()) returning * into target;
  else
    select * into target from public.accounts where id=p_target and venue_id=source.venue_id;
    if target.id is null or target.id=source.id or target.status='CLOSED' or target.floor_released_at is not null or target.version is distinct from p_target_version
      or not target.table_id=any(private.table_group(source.table_id)) then raise exception 'INVALID_TRANSFER_TARGET'; end if;
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
    or (select count(distinct value->>'item_id') from jsonb_array_elements(p_items))<>jsonb_array_length(p_items) then raise exception 'INVALID_ALLOCATIONS'; end if;
  for entry in select value from jsonb_array_elements(p_items) loop
    if entry-array['item_id','quantity']<>'{}'::jsonb or (entry->>'quantity') !~ '^[1-9][0-9]{0,2}$' then raise exception 'INVALID_ALLOCATIONS'; end if;
    qty:=(entry->>'quantity')::integer;found_count:=0;
    for unit in select * from private.billing_balance(source.id) where order_item_id=(entry->>'item_id')::uuid and paid_cents=0 and pending_cents=0 order by unit_number,id limit qty loop
      selected:=array_append(selected,unit.id);found_count:=found_count+1;
    end loop;
    if found_count<>qty then raise exception 'SETTLED_ITEM_REQUIRES_CORRECTION'; end if;
  end loop;
  update public.billing_units set account_id=target.id where id=any(selected);
  insert into public.account_splits(venue_id,source_account_id,target_account_id,kind,details,operator_user_id)
    values(source.venue_id,source.id,target.id,'ITEMS',jsonb_build_object('units',selected,'selection',p_items),private.effective_user_id()) returning id into ref;
  update public.equal_split_plans set status='OBSOLETE',obsolete_at=now() where account_id in(source.id,target.id) and status='ACTIVE';
  perform private.refresh_account_payment_status(source.id);perform private.refresh_account_payment_status(target.id);
  perform private.audit('ACCOUNT_ITEMS_TRANSFERRED','account_splits',ref,source.venue_id,null,jsonb_build_object('source_account_id',source.id,'target_account_id',target.id,'units',selected));
  return private.idempotency_finish('move_account_items',p_key,jsonb_build_object('id',ref,'target_account_id',target.id));
end $$;
grant execute on function public.move_account_items(uuid,uuid,text,jsonb,bigint,bigint,uuid) to authenticated;

create function public.merge_accounts(p_source uuid,p_target uuid,p_source_version bigint,p_target_version bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare source public.accounts; selection jsonb; previous jsonb; result jsonb;
begin
  select * into source from public.accounts where id=p_source;
  if source.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(source.venue_id,array['ADMIN','CASHIER']::public.user_role[]);
  perform private.lock_floor(source.venue_id);
  perform 1 from public.accounts where id in(p_source,p_target) order by id for update;
  previous:=private.idempotency_begin('merge_accounts',p_key,jsonb_build_object('source',p_source,'target',p_target,'source_version',p_source_version,'target_version',p_target_version));
  if previous is not null then return previous; end if;
  if exists(select 1 from private.billing_balance(p_source) where pending_cents>0 or (paid_cents>0 and available_cents>0)) then raise exception 'PENDING_PAYMENT_RECONCILIATION_REQUIRED'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('item_id',order_item_id,'quantity',qty)),'[]') into selection
    from (select order_item_id,count(*) qty from private.billing_balance(p_source) where paid_cents=0 and pending_cents=0 group by order_item_id) x;
  if selection='[]'::jsonb then raise exception 'NO_ITEMS_TO_TRANSFER'; end if;
  result:=public.move_account_items(p_source,p_target,null,selection,p_source_version,p_target_version,p_key);
  update public.accounts set covers=covers+source.covers where id=p_target;
  update public.accounts set status='CLOSED',closed_at=now(),covers=0,financial_partition=true,access_epoch=access_epoch+1 where id=p_source;
  delete from private.customer_access_codes where account_id=p_source;
  update private.customer_sessions set revoked_at=now() where account_id=p_source and revoked_at is null;
  perform private.audit('ACCOUNTS_MERGED','accounts',p_source,source.venue_id,null,jsonb_build_object('target_account_id',p_target));
  return private.idempotency_finish('merge_accounts',p_key,result);
end $$;
grant execute on function public.merge_accounts(uuid,uuid,bigint,bigint,uuid) to authenticated;

-- Customer history is based on the authoritative charge owner after a split, not
-- on the immutable kitchen order's original account.
create or replace function public.get_customer_account(p_public_table uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.accounts; settings public.venue_settings;
begin
  select account.* into a from public.accounts account join public.tables t on t.id=account.table_id
    where t.public_table_id=p_public_table and private.owns_customer_account(account.id) order by account.created_at desc limit 1;
  if a.id is null then raise exception 'CUSTOMER_SESSION_REQUIRED' using errcode='42501'; end if;
  select * into settings from public.venue_settings where venue_id=a.venue_id;
  return jsonb_build_object('id',a.id,'name',a.account_name,'covers',a.covers,'venue_id',a.venue_id,'balance',private.account_balance(a.id),
    'customer_ordering',case when exists(select 1 from public.feature_flags where name='CLIENT_ORDERING' and licensed) then settings.customer_ordering else 'DISABLED' end,'bill_request_enabled',settings.customer_bill_request,
    'items',coalesce((select jsonb_agg(to_jsonb(row) order by row.ordered_at,row.name) from (
      select i.dish_name name,count(*)::integer quantity,i.unit_price_cents,o.created_at ordered_at from public.billing_units u join public.order_items i on i.id=u.order_item_id join public.orders o on o.id=i.order_id
      where u.account_id=a.id and u.voided_at is null group by i.id,o.created_at) row),'[]'),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'created_at',r.created_at)) from public.customer_order_requests r where r.account_id=a.id),'[]'));
end $$;

-- Append a financial-origin projection without leaking another guest's account.
alter function public.get_account_workspace(uuid,timestamptz,uuid,integer) rename to original_account_workspace;
alter function public.original_account_workspace(uuid,timestamptz,uuid,integer) set schema private;
revoke all on function private.original_account_workspace(uuid,timestamptz,uuid,integer) from authenticated;
create function public.get_account_workspace(p_account uuid,p_before_at timestamptz default null,p_before_id uuid default null,p_limit integer default 25) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  result:=private.original_account_workspace(p_account,p_before_at,p_before_id,p_limit);
  return result||(
    with page as (
      select o.id,o.created_at,o.status,o.version from public.orders o where (o.account_id=p_account or exists(select 1 from public.order_items i join public.billing_units u on u.order_item_id=i.id where i.order_id=o.id and u.account_id=p_account and u.voided_at is null))
        and (p_before_at is null or (o.created_at,o.id)<(p_before_at,p_before_id)) order by o.created_at desc,o.id desc limit p_limit+1
    ) select jsonb_build_object('orders',coalesce((select jsonb_agg(to_jsonb(row)||jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'dish_name',i.dish_name,'quantity',case when i.status='CANCELLED' then i.quantity else (select count(*) from public.billing_units u where u.order_item_id=i.id and u.account_id=p_account and u.voided_at is null) end,'unit_price_cents',i.unit_price_cents,'status',i.status)) from public.order_items i where i.order_id=row.id and (exists(select 1 from public.billing_units u where u.order_item_id=i.id and u.account_id=p_account and u.voided_at is null) or (i.status='CANCELLED' and exists(select 1 from public.orders where id=i.order_id and account_id=p_account)))),'[]')) order by row.created_at desc,row.id desc) from (select * from page order by created_at desc,id desc limit p_limit) row),'[]'),'has_more',(select count(*)>p_limit from page)));
end $$;
grant execute on function public.get_account_workspace(uuid,timestamptz,uuid,integer) to authenticated;
commit;
