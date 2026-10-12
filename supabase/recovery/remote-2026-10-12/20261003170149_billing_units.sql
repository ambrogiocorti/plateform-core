begin;
-- Fulfillment stays on order_items; billing ownership and settlement are separate.
create table public.billing_units (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  account_id uuid not null, order_item_id uuid not null, unit_number integer not null check(unit_number between 1 and 999),
  gross_cents bigint not null check(gross_cents between 0 and 100000000), discount_cents bigint not null default 0 check(discount_cents>=0 and discount_cents<=gross_cents),
  voided_at timestamptz, created_at timestamptz not null default now(), unique(order_item_id,unit_number), unique(venue_id,id),
  foreign key(venue_id,account_id) references public.accounts(venue_id,id), foreign key(venue_id,order_item_id) references public.order_items(venue_id,id)
);
create index billing_account on public.billing_units(account_id,order_item_id,unit_number) where voided_at is null;
create table public.payment_unit_allocations (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), payment_id uuid not null, billing_unit_id uuid not null,
  amount_cents bigint not null check(amount_cents>0), mode text not null check(mode in ('AMOUNT','ITEMS')), created_at timestamptz not null default now(),
  unique(payment_id,billing_unit_id), foreign key(venue_id,payment_id) references public.payments(venue_id,id), foreign key(venue_id,billing_unit_id) references public.billing_units(venue_id,id)
);
create index allocation_unit on public.payment_unit_allocations(billing_unit_id,payment_id);
create table public.discount_unit_allocations (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), discount_id uuid not null references public.discounts(id), billing_unit_id uuid not null,
  amount_cents bigint not null check(amount_cents>0), unique(discount_id,billing_unit_id), foreign key(venue_id,billing_unit_id) references public.billing_units(venue_id,id)
);
do $$ declare entity text; begin
  foreach entity in array array['billing_units','payment_unit_allocations','discount_unit_allocations'] loop
    execute format('alter table public.%I enable row level security',entity);
    execute format('revoke all on public.%I from public,anon,authenticated',entity);
    execute format('grant select on public.%I to authenticated',entity);
  end loop;
end $$;
create policy billing_read on public.billing_units for select to authenticated using(private.can_read_account(account_id));
create policy allocations_read on public.payment_unit_allocations for select to authenticated using(private.is_role(array['ADMIN','CASHIER']::public.user_role[]) and private.has_venue(venue_id));
create policy discounts_read on public.discount_unit_allocations for select to authenticated using(private.is_role(array['ADMIN','CASHIER']::public.user_role[]) and private.has_venue(venue_id));

insert into public.billing_units(venue_id,account_id,order_item_id,unit_number,gross_cents,voided_at)
  select i.venue_id,o.account_id,i.id,n,i.unit_price_cents,case when i.status='CANCELLED' then now() end
  from public.order_items i join public.orders o on o.id=i.order_id cross join lateral generate_series(1,i.quantity) n;

create function private.billing_balance(p_account uuid)
returns table(id uuid,order_item_id uuid,unit_number integer,gross_cents bigint,discount_cents bigint,net_cents bigint,paid_cents bigint,pending_cents bigint,available_cents bigint)
language sql stable security definer set search_path='' as $$
  select u.id,u.order_item_id,u.unit_number,u.gross_cents,u.discount_cents,u.gross_cents-u.discount_cents,
    coalesce(s.paid,0)::bigint,coalesce(s.pending,0)::bigint,(u.gross_cents-u.discount_cents-coalesce(s.paid,0)-coalesce(s.pending,0))::bigint
  from public.billing_units u left join lateral (
    select sum(a.amount_cents) filter(where p.status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')) paid,
      sum(a.amount_cents) filter(where p.status='PENDING') pending
    from public.payment_unit_allocations a join public.payments p on p.id=a.payment_id where a.billing_unit_id=u.id
  ) s on true where u.account_id=p_account and u.voided_at is null
$$;

create function private.allocate_billing_discount(p_discount uuid,p_units uuid[] default null) returns void language plpgsql security definer set search_path='' as $$
declare discount public.discounts; available bigint;
begin
  select * into discount from public.discounts where id=p_discount;
  perform 1 from public.accounts where id=discount.account_id for update;
  if exists(select 1 from private.billing_balance(discount.account_id) where pending_cents>0) then raise exception 'PENDING_PAYMENT_RECONCILIATION_REQUIRED'; end if;
  select coalesce(sum(available_cents),0) into available from private.billing_balance(discount.account_id) where (p_units is null or id=any(p_units));
  if discount.id is null or discount.amount_cents<=0 or discount.amount_cents>available then raise exception 'DISCOUNT_EXCEEDS_UNPAID'; end if;
  with weights as (
    select id,available_cents from private.billing_balance(discount.account_id) where available_cents>0 and (p_units is null or id=any(p_units))
  ), shares as (
    select id,floor(discount.amount_cents::numeric*available_cents/available)::bigint base,
      row_number() over(order by mod(discount.amount_cents::numeric*available_cents,available) desc,id) priority from weights
  ), assigned as (
    select id,base+case when priority<=discount.amount_cents-sum(base) over() then 1 else 0 end amount from shares
  ), entries as (
    insert into public.discount_unit_allocations(venue_id,discount_id,billing_unit_id,amount_cents)
      select discount.venue_id,discount.id,id,amount from assigned where amount>0 returning billing_unit_id,amount_cents
  ) update public.billing_units u set discount_cents=u.discount_cents+e.amount_cents from entries e where u.id=e.billing_unit_id;
end $$;

-- Fail rather than silently change existing discounts or selected products during backfill.
do $$ declare d public.discounts; selected uuid[]; begin
  for d in select * from public.discounts where amount_cents>0 order by created_at,id loop
    selected:=null;
    if d.order_item_id is not null then
      select array_agg(id) into selected from public.billing_units where order_item_id=d.order_item_id and account_id=d.account_id and voided_at is null;
      if selected is null then raise exception 'MIGRATION_DISCOUNT_RECONCILIATION_REQUIRED'; end if;
    end if;
    perform private.allocate_billing_discount(d.id,selected);
  end loop;
end $$;

create function private.reserve_billing_units(p_payment uuid,p_items jsonb default '[]') returns void language plpgsql security definer set search_path='' as $$
declare payment public.payments; selection jsonb; item_quantity integer; unit record; selected_count integer; total bigint:=0; remaining bigint; allocation bigint;
begin
  select * into payment from public.payments where id=p_payment;
  if payment.id is null or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>100 then raise exception 'INVALID_ALLOCATIONS'; end if;
  if (select count(distinct value->>'item_id') from jsonb_array_elements(p_items))<>jsonb_array_length(p_items) then raise exception 'INVALID_ALLOCATIONS'; end if;
  if jsonb_array_length(p_items)>0 then
    for selection in select value from jsonb_array_elements(p_items) loop
      if jsonb_typeof(selection)<>'object' or selection-array['item_id','quantity']<>'{}'::jsonb or jsonb_typeof(selection->'quantity') is distinct from 'number' or (selection->>'quantity') !~ '^[1-9][0-9]{0,2}$' then raise exception 'INVALID_ALLOCATION_ITEM'; end if;
      item_quantity:=(selection->>'quantity')::integer; selected_count:=0;
      for unit in select * from private.billing_balance(payment.account_id) where order_item_id=(selection->>'item_id')::uuid and available_cents>0 and pending_cents=0 order by unit_number,id limit item_quantity loop
        insert into public.payment_unit_allocations(venue_id,payment_id,billing_unit_id,amount_cents,mode) values(payment.venue_id,payment.id,unit.id,unit.available_cents,'ITEMS');
        total:=total+unit.available_cents; selected_count:=selected_count+1;
      end loop;
      if item_quantity is null or selected_count<>item_quantity then raise exception 'ITEM_ALREADY_ALLOCATED'; end if;
    end loop;
    if total<>payment.amount_cents then raise exception 'ALLOCATION_AMOUNT_MISMATCH'; end if;
  else
    remaining:=payment.amount_cents;
    for unit in select * from private.billing_balance(payment.account_id) where available_cents>0 order by order_item_id,unit_number,id loop
      allocation:=least(unit.available_cents,remaining);
      insert into public.payment_unit_allocations(venue_id,payment_id,billing_unit_id,amount_cents,mode) values(payment.venue_id,payment.id,unit.id,allocation,'AMOUNT');
      remaining:=remaining-allocation; exit when remaining=0;
    end loop;
    if remaining<>0 then raise exception 'INVALID_PAYMENT_AMOUNT'; end if;
  end if;
end $$;

do $$ declare payment public.payments; selected jsonb; begin
  for payment in select p.* from public.payments p where p.status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
    order by exists(select 1 from public.payment_allocations where payment_id=p.id) desc,p.created_at,p.id loop
    select coalesce(jsonb_agg(jsonb_build_object('item_id',order_item_id,'quantity',quantity)),'[]') into selected from public.payment_allocations where payment_id=payment.id;
    perform private.reserve_billing_units(payment.id,selected);
  end loop;
end $$;

create function private.guard_billing_unit() returns trigger language plpgsql security definer set search_path='' as $$
declare assigned bigint;
begin
  if tg_op='DELETE' or (to_jsonb(new)-array['account_id','discount_cents','voided_at']) is distinct from (to_jsonb(old)-array['account_id','discount_cents','voided_at']) then raise exception 'IMMUTABLE_BILLING_ORIGIN'; end if;
  if old.voided_at is not null and new.voided_at is distinct from old.voided_at then raise exception 'IMMUTABLE_BILLING_ORIGIN'; end if;
  select coalesce(sum(a.amount_cents),0) into assigned from public.payment_unit_allocations a join public.payments p on p.id=a.payment_id where a.billing_unit_id=old.id and p.status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED');
  if (new.voided_at is not null and assigned>0) or new.gross_cents-new.discount_cents<assigned then raise exception 'SETTLED_ITEM_REQUIRES_CORRECTION'; end if;
  return new;
end $$;
create trigger guard_billing_unit before update or delete on public.billing_units for each row execute function private.guard_billing_unit();

create function private.sync_item_billing() returns trigger language plpgsql security definer set search_path='' as $$
declare account uuid;
begin
  select account_id into account from public.orders where id=new.order_id;
  if tg_op='UPDATE' and (new.order_id<>old.order_id or new.unit_price_cents<>old.unit_price_cents) then raise exception 'IMMUTABLE_ORDER_BILLING_ORIGIN'; end if;
  insert into public.billing_units(venue_id,account_id,order_item_id,unit_number,gross_cents,voided_at)
    select new.venue_id,account,new.id,n,new.unit_price_cents,case when new.status='CANCELLED' then now() end from generate_series(1,new.quantity) n on conflict(order_item_id,unit_number) do nothing;
  update public.billing_units set voided_at=now() where order_item_id=new.id and voided_at is null and (new.status='CANCELLED' or unit_number>new.quantity);
  if new.status<>'CANCELLED' and exists(select 1 from public.billing_units where order_item_id=new.id and unit_number<=new.quantity and voided_at is not null) then raise exception 'CREATE_REPLACEMENT_ITEM'; end if;
  return new;
end $$;
create trigger sync_item_billing after insert or update on public.order_items for each row execute function private.sync_item_billing();

create function private.check_unit_allocation() returns trigger language plpgsql security definer set search_path='' as $$
declare unit public.billing_units; assigned bigint; payment_amount bigint;
begin
  select * into unit from public.billing_units where id=new.billing_unit_id for update;
  select amount_cents into payment_amount from public.payments where id=new.payment_id;
  if new.amount_cents+coalesce((select sum(amount_cents) from public.payment_unit_allocations where payment_id=new.payment_id),0)>payment_amount then raise exception 'ALLOCATION_AMOUNT_MISMATCH'; end if;
  if exists(select 1 from public.payments where id=new.payment_id and status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED')) then
    select coalesce(sum(a.amount_cents),0) into assigned from public.payment_unit_allocations a join public.payments p on p.id=a.payment_id where a.billing_unit_id=unit.id and p.status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED');
    if unit.voided_at is not null or assigned+new.amount_cents>unit.gross_cents-unit.discount_cents then raise exception 'ITEM_ALREADY_ALLOCATED'; end if;
  end if;
  return new;
end $$;
create trigger check_unit_allocation before insert on public.payment_unit_allocations for each row execute function private.check_unit_allocation();
do $$ declare entity text; begin
  foreach entity in array array['payment_unit_allocations','discount_unit_allocations'] loop
    execute format('create trigger immutable before update or delete on public.%I for each row execute function private.immutable_record()',entity);
    execute format('create trigger immutable_truncate before truncate on public.%I for each statement execute function private.immutable_record()',entity);
  end loop;
end $$;
create trigger billing_no_truncate before truncate on public.billing_units for each statement execute function private.immutable_record();

create or replace function private.account_balance(p_account uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('gross_cents',coalesce(sum(gross_cents),0),'discount_cents',coalesce(sum(discount_cents),0),'total_cents',coalesce(sum(net_cents),0),
    'paid_cents',coalesce(sum(paid_cents),0),'pending_cents',coalesce(sum(pending_cents),0),'remaining_cents',coalesce(sum(net_cents-paid_cents),0),'available_cents',coalesce(sum(available_cents),0))
  from private.billing_balance(p_account)
$$;

-- create_payment is replaced below in this same transaction before this ledger becomes active.
create or replace function public.create_payment(p_account uuid,p_register uuid,p_amount bigint,p_tip bigint,p_method public.payment_method,p_key uuid,p_items jsonb default '[]') returns jsonb language plpgsql security definer set search_path='' as $$
declare account public.accounts; register public.cash_registers; session_ref uuid; previous jsonb; balance jsonb; payment_ref uuid;
begin
  select * into account from public.accounts where id=p_account for update;
  if account.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(account.venue_id,array['CASHIER','ADMIN']::public.user_role[]);
  if not private.can_use_register(p_register) then raise exception 'REGISTER_FORBIDDEN'; end if;
  previous:=private.idempotency_begin('create_payment',p_key,jsonb_build_object('account',p_account,'register',p_register,'amount',p_amount,'tip',p_tip,'method',p_method,'items',p_items));
  if previous is not null then return previous; end if;
  select * into register from public.cash_registers where id=p_register and venue_id=account.venue_id and active and status='OPEN';
  if register.id is null or p_method is null or not p_method=any(register.payment_methods) or not exists(select 1 from public.venue_settings where venue_id=account.venue_id and p_method=any(payment_methods)) then raise exception 'PAYMENT_METHOD_UNAVAILABLE'; end if;
  if p_method in ('STRIPE','SATISPAY_API') and not exists(select 1 from public.feature_flags where name=p_method::text and licensed) then raise exception 'PAYMENT_METHOD_UNLICENSED'; end if;
  select s.id into session_ref from public.service_sessions s join public.cash_register_sessions c on c.service_session_id=s.id
    where c.cash_register_id=register.id and c.closed_at is null and s.status='OPEN' for update of s;
  if session_ref is null then raise exception 'SERVICE_NOT_OPEN'; end if;
  if account.status='CLOSED' then raise exception 'ACCOUNT_CLOSED'; end if;
  balance:=private.account_balance(account.id);
  if p_amount is null or p_amount<=0 or p_tip is null or p_tip<0 or p_amount>(balance->>'available_cents')::bigint then raise exception 'INVALID_PAYMENT_AMOUNT'; end if;
  insert into public.payments(venue_id,account_id,cash_register_id,service_session_id,operator_user_id,method,amount_cents,tip_cents,currency,idempotency_key)
    values(account.venue_id,account.id,register.id,session_ref,private.effective_user_id(),p_method,p_amount,p_tip,(select currency from public.venues where id=account.venue_id),p_key) returning id into payment_ref;
  perform private.reserve_billing_units(payment_ref,p_items);
  -- Retain the legacy product links for existing reports; the unit ledger is authoritative.
  insert into public.payment_allocations(venue_id,payment_id,order_item_id,quantity,amount_cents)
    select account.venue_id,payment_ref,u.order_item_id,count(*)::integer,sum(a.amount_cents) from public.payment_unit_allocations a join public.billing_units u on u.id=a.billing_unit_id
    where a.payment_id=payment_ref and a.mode='ITEMS' group by u.order_item_id;
  update public.accounts set status='AT_CASHIER' where id=account.id and status not in ('PARTIALLY_PAID','PAID');
  return private.idempotency_finish('create_payment',p_key,jsonb_build_object('id',payment_ref,'status','PENDING','amount_cents',p_amount,'tip_cents',p_tip));
end $$;

create function private.assert_payment_units() returns trigger language plpgsql security definer set search_path='' as $$
declare payment public.payments; unit public.billing_units; assigned bigint;
begin
  select * into payment from public.payments where id=new.id;
  if payment.status not in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED') then return null; end if;
  if coalesce((select sum(amount_cents) from public.payment_unit_allocations where payment_id=payment.id),0)<>payment.amount_cents then raise exception 'ALLOCATION_AMOUNT_MISMATCH'; end if;
  for unit in select u.* from public.billing_units u where id in(select billing_unit_id from public.payment_unit_allocations where payment_id=payment.id) order by id for update loop
    select sum(a.amount_cents) into assigned from public.payment_unit_allocations a join public.payments p on p.id=a.payment_id where a.billing_unit_id=unit.id and p.status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED');
    if unit.voided_at is not null or assigned>unit.gross_cents-unit.discount_cents then raise exception 'ITEM_ALREADY_ALLOCATED'; end if;
  end loop;
  return null;
end $$;
create constraint trigger assert_payment_units after insert or update on public.payments deferrable initially deferred for each row execute function private.assert_payment_units();

create function private.signal_billing_insert() returns trigger language plpgsql security definer set search_path='' as $$
declare account record;
begin
  for account in select distinct venue_id,account_id from new_units loop perform private.emit_signal('ACCOUNT',account.venue_id,account.account_id,account.account_id); end loop;
  return null;
end $$;
create function private.signal_billing_update() returns trigger language plpgsql security definer set search_path='' as $$
declare account record;
begin
  for account in select venue_id,account_id from new_units union select venue_id,account_id from old_units loop perform private.emit_signal('ACCOUNT',account.venue_id,account.account_id,account.account_id); end loop;
  return null;
end $$;
create trigger signal_billing_insert after insert on public.billing_units referencing new table as new_units for each statement execute function private.signal_billing_insert();
create trigger signal_billing_update after update on public.billing_units referencing old table as old_units new table as new_units for each statement execute function private.signal_billing_update();
commit;
