begin;
create index account_search_cursor on public.accounts(venue_id,created_at desc,id desc);
create index order_account_cursor on public.orders(account_id,created_at desc,id desc);
create index payment_account_cursor on public.payments(account_id,created_at desc,id desc);

create function public.search_accounts(p_venue uuid,p_search text default '',p_status text default 'ACTIVE',p_table uuid default null,p_from timestamptz default null,p_to timestamptz default null,p_before_at timestamptz default null,p_before_id uuid default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize(p_venue,array['ADMIN','CASHIER','WAITER']::public.user_role[],false);
  if p_limit is null or p_limit not between 1 and 100 or p_status is null or p_status not in ('ACTIVE','CLOSED','ALL') or coalesce(length(p_search),0)>100
    or (p_before_at is null)<>(p_before_id is null) or (p_from is not null and p_to is not null and p_from>p_to) then raise exception 'INVALID_FILTER'; end if;
  return (with page as (
    select a.id,a.account_name,a.table_id,t.name table_name,a.covers,a.status,a.version,a.created_at,a.closed_at
    from public.accounts a join public.tables t on t.id=a.table_id
    where a.venue_id=p_venue and private.can_read_account(a.id) and (p_status='ALL' or (p_status='ACTIVE' and a.status<>'CLOSED') or (p_status='CLOSED' and a.status='CLOSED'))
      and (p_table is null or a.table_id=p_table) and (coalesce(p_search,'')='' or strpos(lower(a.account_name||' '||t.name||' '||t.number::text||' '||a.id::text),lower(p_search))>0)
      and (p_from is null or a.created_at>=p_from) and (p_to is null or a.created_at<=p_to)
      and (p_before_at is null or (a.created_at,a.id)<(p_before_at,p_before_id)) order by a.created_at desc,a.id desc limit p_limit+1
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(item) order by item.created_at desc,item.id desc) from (select * from page order by created_at desc,id desc limit p_limit) item),'[]'),'has_more',(select count(*)>p_limit from page)));
end $$;

create function public.get_account_workspace(p_account uuid,p_before_at timestamptz default null,p_before_id uuid default null,p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare account public.accounts;
begin
  if not private.can_read_account(p_account) then raise exception 'FORBIDDEN'; end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_at is null)<>(p_before_id is null) then raise exception 'INVALID_FILTER'; end if;
  select * into account from public.accounts where id=p_account;
  return (with page as (
    select o.id,o.created_at,o.status from public.orders o where o.account_id=account.id
    and (p_before_at is null or (o.created_at,o.id)<(p_before_at,p_before_id)) order by o.created_at desc,o.id desc limit p_limit+1
  ) select jsonb_build_object('account',jsonb_build_object('id',account.id,'venue_id',account.venue_id,'account_name',account.account_name,'table_id',account.table_id,
      'table_name',(select name from public.tables where id=account.table_id),'covers',account.covers,'status',account.status,'version',account.version),
    'balance',private.account_balance(account.id),'orders',coalesce((select jsonb_agg(to_jsonb(item)||jsonb_build_object('items',
       coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'dish_name',i.dish_name,'quantity',i.quantity,'unit_price_cents',i.unit_price_cents,'status',i.status) order by i.id) from public.order_items i where i.order_id=item.id),'[]')) order by item.created_at desc,item.id desc)
      from (select * from page order by created_at desc,id desc limit p_limit) item),'[]'),'has_more',(select count(*)>p_limit from page)));
end $$;

create function public.get_account_payments(p_account uuid,p_before_at timestamptz default null,p_before_id uuid default null,p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare venue uuid;
begin
  select venue_id into venue from public.accounts where id=p_account;
  if venue is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(venue,array['ADMIN','CASHIER']::public.user_role[],false);
  if p_limit is null or p_limit not between 1 and 100 or (p_before_at is null)<>(p_before_id is null) then raise exception 'INVALID_FILTER'; end if;
  return (with page as (
    select p.id,p.account_id,p.cash_register_id,r.name register_name,p.method,p.amount_cents,p.tip_cents,p.status,p.created_at,p.completed_at,p.operator_user_id,
      coalesce((select sum(f.amount_cents) from public.refunds f where f.original_payment_id=p.id and f.status not in ('FAILED','REJECTED')),0) refunded_cents,
      coalesce((select sum(f.tip_cents) from public.refunds f where f.original_payment_id=p.id and f.status not in ('FAILED','REJECTED')),0) refunded_tip_cents,
      coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'amount_cents',f.amount_cents,'tip_cents',f.tip_cents,'status',f.status,'reason',f.reason,'created_at',f.created_at) order by f.created_at desc,f.id desc) from public.refunds f where f.original_payment_id=p.id),'[]') refunds
    from public.payments p join public.cash_registers r on r.id=p.cash_register_id where p.account_id=p_account
      and (p_before_at is null or (p.created_at,p.id)<(p_before_at,p_before_id)) order by p.created_at desc,p.id desc limit p_limit+1
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(item) order by item.created_at desc,item.id desc) from (select * from page order by created_at desc,id desc limit p_limit) item),'[]'),'has_more',(select count(*)>p_limit from page)));
end $$;

create function public.get_payment_registers(p_venue uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize(p_venue,array['ADMIN','CASHIER']::public.user_role[],false);
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'status',r.status,'service_session_id',s.id,
    'payment_methods',coalesce((select jsonb_agg(method) from unnest(r.payment_methods) method where method=any(v.payment_methods)),'[]')) order by r.name)
    from public.cash_registers r join public.venue_settings v on v.venue_id=r.venue_id
      join public.cash_register_sessions c on c.cash_register_id=r.id and c.closed_at is null
      join public.service_sessions s on s.id=c.service_session_id and s.status='OPEN'
    where r.venue_id=p_venue and r.status='OPEN' and private.can_use_register(r.id)),'[]');
end $$;

grant execute on function public.search_accounts(uuid,text,text,uuid,timestamptz,timestamptz,timestamptz,uuid,integer),public.get_account_workspace(uuid,timestamptz,uuid,integer),
  public.get_account_payments(uuid,timestamptz,uuid,integer),public.get_payment_registers(uuid) to authenticated;
commit;
