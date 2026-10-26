begin;
create function private.account_balance(p_account uuid) returns jsonb language sql stable security definer set search_path='' as $$
  with charges as (
    select coalesce(sum(i.quantity::bigint*i.unit_price_cents),0)::bigint gross from public.order_items i join public.orders o on o.id=i.order_id
      where o.account_id=p_account and i.status<>'CANCELLED'
  ), reductions as (select coalesce(sum(amount_cents),0)::bigint discount from public.discounts where account_id=p_account),
  settlements as (select coalesce(sum(amount_cents) filter(where status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')),0)::bigint paid,
    coalesce(sum(amount_cents) filter(where status='PENDING'),0)::bigint reserved from public.payments where account_id=p_account)
  select jsonb_build_object('gross_cents',gross,'discount_cents',discount,'total_cents',greatest(0,gross-discount),
    'paid_cents',paid,'pending_cents',reserved,'remaining_cents',greatest(0,gross-discount)-paid,'available_cents',greatest(0,gross-discount)-paid-reserved)
    from charges,reductions,settlements
$$;
create function public.get_account_balance(p_account uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.can_read_account(p_account) and not private.owns_customer_account(p_account) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  return private.account_balance(p_account);
end $$;
create function private.refresh_account_payment_status(p_account uuid) returns void language plpgsql security definer set search_path='' as $$
declare balance jsonb;
begin
  balance:=private.account_balance(p_account);
  update public.accounts set status=case when (balance->>'remaining_cents')::bigint=0 then 'PAID'::public.account_status
    when (balance->>'paid_cents')::bigint>0 then 'PARTIALLY_PAID'::public.account_status else 'AT_CASHIER'::public.account_status end
    where id=p_account and status<>'CLOSED';
end $$;

create function public.set_cash_register_open(p_register uuid,p_open boolean) returns void language plpgsql security definer set search_path='' as $$
declare r public.cash_registers;
begin
  select * into r from public.cash_registers where id=p_register for update;
  perform private.authorize(r.venue_id,array['CASHIER','ADMIN']::public.user_role[]);
  if r.id is null or not private.can_use_register(r.id) then raise exception 'REGISTER_FORBIDDEN' using errcode='42501'; end if;
  update public.cash_registers set status=case when p_open then 'OPEN' else 'CLOSED' end where id=r.id;
end $$;
create function public.open_service_session(p_venue uuid,p_service uuid,p_register uuid,p_float bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare ref uuid; result jsonb;
begin
  perform private.authorize(p_venue,array['CASHIER','ADMIN']::public.user_role[]);
  if not private.can_use_register(p_register) or not exists(select 1 from public.cash_registers where id=p_register and venue_id=p_venue and status='OPEN') then raise exception 'REGISTER_NOT_OPEN'; end if;
  result:=private.idempotency_begin('open_service',p_key,jsonb_build_object('venue',p_venue,'service',p_service,'register',p_register,'float',p_float));
  if result is not null then return result; end if;
  perform 1 from public.cash_registers where id=p_register for update;
  if exists(select 1 from public.cash_register_sessions where cash_register_id=p_register and closed_at is null) then raise exception 'SERVICE_ALREADY_OPEN'; end if;
  insert into public.service_sessions(venue_id,service_id,opened_by) values(p_venue,p_service,private.effective_user_id()) returning id into ref;
  insert into public.cash_register_sessions(venue_id,cash_register_id,service_session_id,opening_float_cents) values(p_venue,p_register,ref,p_float);
  return private.idempotency_finish('open_service',p_key,jsonb_build_object('id',ref));
end $$;

create function public.create_payment(p_account uuid,p_register uuid,p_amount bigint,p_tip bigint,p_method public.payment_method,p_key uuid,p_items jsonb default '[]') returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.accounts; r public.cash_registers; session_ref uuid; result jsonb; balance jsonb; payment_ref uuid;
  selected jsonb; item public.order_items; allocated bigint; item_total bigint:=0; item_qty integer;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['CASHIER','ADMIN']::public.user_role[]);
  if not private.can_use_register(p_register) then raise exception 'REGISTER_FORBIDDEN' using errcode='42501'; end if;
  result:=private.idempotency_begin('create_payment',p_key,jsonb_build_object('account',p_account,'register',p_register,'amount',p_amount,'tip',p_tip,'method',p_method,'items',p_items));
  if result is not null then return result; end if;
  select * into r from public.cash_registers where id=p_register and venue_id=a.venue_id and active and status='OPEN';
  if r.id is null or not p_method=any(r.payment_methods) or not exists(select 1 from public.venue_settings where venue_id=a.venue_id and p_method=any(payment_methods)) then raise exception 'PAYMENT_METHOD_UNAVAILABLE'; end if;
  if p_method in ('STRIPE','SATISPAY_API') and not exists(select 1 from public.feature_flags where name=p_method::text and licensed) then raise exception 'PAYMENT_METHOD_UNLICENSED'; end if;
  select s.id into session_ref from public.service_sessions s join public.cash_register_sessions c on c.service_session_id=s.id
    where c.cash_register_id=r.id and c.closed_at is null and s.status='OPEN' for update of s;
  if session_ref is null then raise exception 'SERVICE_NOT_OPEN'; end if;
  if a.status='CLOSED' then raise exception 'ACCOUNT_CLOSED'; end if;
  balance:=private.account_balance(a.id);
  if p_amount is null or p_amount<=0 or p_tip is null or p_tip<0 or p_amount>(balance->>'available_cents')::bigint then raise exception 'INVALID_PAYMENT_AMOUNT'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>100 then raise exception 'INVALID_ALLOCATIONS'; end if;
  if jsonb_array_length(p_items)>0 then
    if (balance->>'discount_cents')::bigint>0 then raise exception 'USE_AMOUNT_SPLIT_FOR_DISCOUNTED_ACCOUNT'; end if;
    for selected in select value from jsonb_array_elements(p_items) loop
      select i.* into item from public.order_items i join public.orders o on o.id=i.order_id where i.id=(selected->>'item_id')::uuid and o.account_id=a.id and i.status<>'CANCELLED' for update of i;
      item_qty:=(selected->>'quantity')::integer;
      if item.id is null or item_qty is null or item_qty<=0 then raise exception 'INVALID_ALLOCATION_ITEM'; end if;
      select coalesce(sum(pa.quantity),0) into allocated from public.payment_allocations pa join public.payments p on p.id=pa.payment_id where pa.order_item_id=item.id and p.status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED');
      if allocated+item_qty>item.quantity then raise exception 'ITEM_ALREADY_ALLOCATED'; end if;
      item_total:=item_total+item_qty*item.unit_price_cents;
    end loop;
    if item_total<>p_amount then raise exception 'ALLOCATION_AMOUNT_MISMATCH'; end if;
  end if;
  insert into public.payments(venue_id,account_id,cash_register_id,service_session_id,operator_user_id,method,amount_cents,tip_cents,currency,idempotency_key)
    values(a.venue_id,a.id,r.id,session_ref,private.effective_user_id(),p_method,p_amount,p_tip,(select currency from public.venues where id=a.venue_id),p_key) returning id into payment_ref;
  for selected in select value from jsonb_array_elements(p_items) loop
    insert into public.payment_allocations(venue_id,payment_id,order_item_id,quantity,amount_cents)
      select a.venue_id,payment_ref,id,(selected->>'quantity')::integer,(selected->>'quantity')::integer*unit_price_cents from public.order_items where id=(selected->>'item_id')::uuid;
  end loop;
  update public.accounts set status='AT_CASHIER' where id=a.id and status not in ('PARTIALLY_PAID','PAID');
  return private.idempotency_finish('create_payment',p_key,jsonb_build_object('id',payment_ref,'status','PENDING','amount_cents',p_amount,'tip_cents',p_tip));
end $$;

create function public.confirm_manual_payment(p_payment uuid,p_success boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
  select * into p from public.payments where id=p_payment;
  if p.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(p.venue_id,array['CASHIER','ADMIN']::public.user_role[]);
  if not private.can_use_register(p.cash_register_id) then raise exception 'REGISTER_FORBIDDEN' using errcode='42501'; end if;
  perform 1 from public.accounts where id=p.account_id for update;
  select * into p from public.payments where id=p_payment for update;
  if p.method not in ('CASH','CARD_POS','SATISPAY_POS') then raise exception 'PROVIDER_CONFIRMATION_REQUIRED' using errcode='42501'; end if;
  if p.status<>'PENDING' then return jsonb_build_object('id',p.id,'status',p.status); end if;
  if not exists(select 1 from public.service_sessions where id=p.service_session_id and status='OPEN') then raise exception 'SERVICE_NOT_OPEN'; end if;
  update public.payments set status=case when p_success then 'COMPLETED'::public.payment_status else 'FAILED'::public.payment_status end,
    completed_at=case when p_success then now() end where id=p.id;
  if p_success and p.tip_cents>0 then insert into public.tips(venue_id,payment_id,amount_cents) values(p.venue_id,p.id,p.tip_cents); end if;
  perform private.refresh_account_payment_status(p.account_id);
  return jsonb_build_object('id',p.id,'status',case when p_success then 'COMPLETED' else 'FAILED' end);
end $$;

create function public.close_account(p_account uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.accounts; balance jsonb;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['CASHIER','ADMIN']::public.user_role[]);
  if a.status='CLOSED' then return; end if;
  balance:=private.account_balance(a.id);
  if (balance->>'remaining_cents')::bigint<>0 or (balance->>'pending_cents')::bigint<>0 then raise exception 'ACCOUNT_NOT_SETTLED'; end if;
  update public.accounts set status='CLOSED',closed_at=now(),access_epoch=access_epoch+1 where id=a.id;
  delete from private.customer_access_codes where account_id=a.id;
  update private.customer_sessions set revoked_at=now() where account_id=a.id and revoked_at is null;
  if not exists(select 1 from public.accounts where table_id=a.table_id and status<>'CLOSED') then update public.tables set technical_status='TO_RESET' where id=a.table_id; end if;
end $$;

create function public.cancel_manual_payment(p_payment uuid,p_reason text,p_step_up uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare p public.payments; a public.accounts;
begin
  select * into p from public.payments where id=p_payment;
  perform private.authorize(p.venue_id,array['ADMIN','CASHIER']::public.user_role[]);
  if p.id is null or p.method not in ('CASH','CARD_POS','SATISPAY_POS') or length(trim(p_reason))<3 then raise exception 'INVALID_MANUAL_REVERSAL'; end if;
  if not private.can_use_register(p.cash_register_id) then raise exception 'REGISTER_FORBIDDEN'; end if;
  select * into a from public.accounts where id=p.account_id for update;
  select * into p from public.payments where id=p_payment for update;
  if p.status='CANCELLED' then return; end if;
  if p.status not in ('COMPLETED','PENDING') or exists(select 1 from public.refunds where original_payment_id=p.id and status not in ('FAILED','REJECTED')) then raise exception 'REFUND_WORKFLOW_REQUIRED'; end if;
  if a.status='CLOSED' then
    perform private.authorize(a.venue_id,array['ADMIN']::public.user_role[]);
    perform private.consume_step_up(p_step_up,'CANCEL_PAYMENT',p.id);
    raise exception 'REOPEN_ACCOUNT_FIRST';
  end if;
  update public.payments set status='CANCELLED' where id=p.id;
  perform private.refresh_account_payment_status(a.id);
end $$;

create function public.create_refund(p_payment uuid,p_amount bigint,p_tip bigint,p_reason text,p_step_up uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments; already bigint; tips_already bigint; ref uuid; result jsonb;
begin
  select * into p from public.payments where id=p_payment;
  if p.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(p.venue_id,array['ADMIN']::public.user_role[]);
  perform 1 from public.accounts where id=p.account_id for update;
  select * into p from public.payments where id=p_payment for update;
  result:=private.idempotency_begin('refund',p_key,jsonb_build_object('payment',p_payment,'amount',p_amount,'tip',p_tip,'reason',p_reason));
  if result is not null then return result; end if;
  perform private.consume_step_up(p_step_up,'REFUND',p.id);
  if p.status not in ('COMPLETED','PARTIALLY_REFUNDED') then raise exception 'PAYMENT_NOT_REFUNDABLE'; end if;
  select coalesce(sum(amount_cents),0),coalesce(sum(tip_cents),0) into already,tips_already from public.refunds where original_payment_id=p.id and status not in ('FAILED','REJECTED');
  if p_amount is null or p_amount<=0 or p_tip is null or p_tip<0 or already+p_amount>p.amount_cents or tips_already+p_tip>p.tip_cents then raise exception 'INVALID_REFUND_AMOUNT'; end if;
  insert into public.refunds(venue_id,original_payment_id,amount_cents,tip_cents,method,authorized_by,status,reason,idempotency_key,completed_at)
    values(p.venue_id,p.id,p_amount,p_tip,p.method,private.effective_user_id(),
      case when p.method in ('STRIPE','SATISPAY_API') then 'PENDING'::public.refund_status else 'COMPLETED'::public.refund_status end,
      p_reason,p_key,case when p.method not in ('STRIPE','SATISPAY_API') then now() end) returning id into ref;
  if p.method not in ('STRIPE','SATISPAY_API') then
    update public.payments set status=case when already+p_amount=p.amount_cents and tips_already+p_tip=p.tip_cents then 'REFUNDED'::public.payment_status else 'PARTIALLY_REFUNDED'::public.payment_status end where id=p.id;
  end if;
  return private.idempotency_finish('refund',p_key,jsonb_build_object('id',ref,'status',case when p.method in ('STRIPE','SATISPAY_API') then 'PENDING' else 'COMPLETED' end));
end $$;
grant execute on function public.get_account_balance(uuid),public.set_cash_register_open(uuid,boolean),public.open_service_session(uuid,uuid,uuid,bigint,uuid),
  public.create_payment(uuid,uuid,bigint,bigint,public.payment_method,uuid,jsonb),public.confirm_manual_payment(uuid,boolean),public.close_account(uuid),
  public.cancel_manual_payment(uuid,text,uuid),public.create_refund(uuid,bigint,bigint,text,uuid,uuid) to authenticated;
commit;
