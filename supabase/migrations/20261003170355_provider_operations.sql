begin;
-- The provider command is created from the immutable payment/refund, never from browser amounts.
create table public.provider_operations (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  payment_id uuid not null references public.payments(id), refund_id uuid unique references public.refunds(id),
  kind text not null check(kind in ('PAYMENT','REFUND')), method public.payment_method not null check(method in ('STRIPE','SATISPAY_API')),
  amount_cents bigint not null check(amount_cents>0), currency text not null default 'EUR' check(currency='EUR'),
  state text not null default 'NEW' check(state in ('NEW','IN_FLIGHT','WAITING','COMPLETED','FAILED')),
  provider_id text, checkout_url text, lease_token uuid, lease_until timestamptz, attempts integer not null default 0,
  first_requested_at timestamptz, last_error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check((kind='PAYMENT' and refund_id is null) or (kind='REFUND' and refund_id is not null))
);
create unique index one_provider_payment on public.provider_operations(payment_id) where kind='PAYMENT';
create index provider_recovery on public.provider_operations(state,lease_until);
alter table public.provider_operations enable row level security;
revoke all on public.provider_operations from public,anon,authenticated;
grant select on public.provider_operations to authenticated;
create policy finance_read on public.provider_operations for select to authenticated using(private.has_venue(venue_id) and private.is_role(array['ADMIN','CASHIER']::public.user_role[]));
create function private.guard_provider_operation() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or tg_op='TRUNCATE' then raise exception 'IMMUTABLE_PROVIDER_COMMAND'; end if;
  if (to_jsonb(new)-array['state','provider_id','checkout_url','lease_token','lease_until','attempts','first_requested_at','last_error','updated_at']) is distinct from
    (to_jsonb(old)-array['state','provider_id','checkout_url','lease_token','lease_until','attempts','first_requested_at','last_error','updated_at'])
    or (old.provider_id is not null and new.provider_id is distinct from old.provider_id)
    or (old.first_requested_at is not null and new.first_requested_at is distinct from old.first_requested_at)
    or (old.state in ('COMPLETED','FAILED') and new.state<>old.state) then raise exception 'IMMUTABLE_PROVIDER_COMMAND'; end if;
  return new;
end $$;
create trigger immutable_provider before update or delete on public.provider_operations for each row execute function private.guard_provider_operation();
create trigger immutable_provider_truncate before truncate on public.provider_operations for each statement execute function private.guard_provider_operation();
create table private.provider_operation_events (
  method public.payment_method not null, event_id text not null check(length(event_id) between 1 and 200),
  operation_id uuid not null references public.provider_operations(id), state text not null, amount_cents bigint not null, currency text not null,
  created_at timestamptz not null default now(), primary key(method,event_id)
);
create trigger immutable_events before update or delete on private.provider_operation_events for each row execute function private.immutable_record();
create trigger immutable_events_truncate before truncate on private.provider_operation_events for each statement execute function private.immutable_record();

create function public.prepare_provider_operation(p_payment uuid,p_refund uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare pay public.payments; refund_row public.refunds; op public.provider_operations;
begin
  select * into pay from public.payments where id=p_payment;
  if pay.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(pay.venue_id,case when p_refund is null then array['ADMIN','CASHIER']::public.user_role[] else array['ADMIN']::public.user_role[] end);
  if not private.can_use_register(pay.cash_register_id) then raise exception 'REGISTER_FORBIDDEN'; end if;
  perform 1 from public.accounts where id=pay.account_id for update;
  select * into pay from public.payments where id=p_payment for update;
  if pay.method not in ('STRIPE','SATISPAY_API') then raise exception 'INVALID_PROVIDER_METHOD'; end if;
  select * into op from public.provider_operations where payment_id=pay.id and refund_id is not distinct from p_refund;
  if op.id is null then
    if p_refund is null then
      if pay.status<>'PENDING' then raise exception 'PAYMENT_NOT_PENDING'; end if;
      insert into public.provider_operations(venue_id,payment_id,kind,method,amount_cents) values(pay.venue_id,pay.id,'PAYMENT',pay.method,pay.amount_cents+pay.tip_cents) returning * into op;
    else
      select * into refund_row from public.refunds where id=p_refund and original_payment_id=pay.id for update;
      if refund_row.id is null or refund_row.status<>'PENDING' or pay.provider_id is null then raise exception 'INVALID_PROVIDER_REFUND'; end if;
      insert into public.provider_operations(venue_id,payment_id,refund_id,kind,method,amount_cents) values(pay.venue_id,pay.id,refund_row.id,'REFUND',pay.method,refund_row.amount_cents+refund_row.tip_cents) returning * into op;
    end if;
    perform private.audit('PROVIDER_COMMAND_CREATED','provider_operations',op.id,op.venue_id,null,jsonb_build_object('kind',op.kind,'payment_id',pay.id));
  end if;
  return jsonb_build_object('id',op.id,'state',op.state,'checkout_url',op.checkout_url);
end $$;
grant execute on function public.prepare_provider_operation(uuid,uuid) to authenticated;

create function public.claim_provider_operation(p_operation uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare op public.provider_operations;
begin
  select * into op from public.provider_operations where id=p_operation for update;
  if op.id is null then raise exception 'NOT_FOUND'; end if;
  if op.state in ('COMPLETED','FAILED') then return jsonb_build_object('id',op.id,'state',op.state); end if;
  if op.lease_until>now() then raise exception 'OPERATION_IN_PROGRESS'; end if;
  -- Never create a fresh charge when the remote idempotency retention might have expired.
  if op.provider_id is null and op.first_requested_at<now()-interval '20 hours' then raise exception 'PROVIDER_RECONCILIATION_REQUIRED'; end if;
  update public.provider_operations set state='IN_FLIGHT',lease_token=gen_random_uuid(),lease_until=now()+interval '45 seconds',attempts=attempts+1,
    first_requested_at=coalesce(first_requested_at,now()),updated_at=now() where id=op.id returning * into op;
  return to_jsonb(op)||jsonb_build_object('original_provider_id',(select provider_id from public.payments where id=op.payment_id));
end $$;
grant execute on function public.claim_provider_operation(uuid) to service_role;

create function public.finish_provider_operation(p_operation uuid,p_lease uuid,p_provider_id text,p_state text,p_amount bigint,p_currency text,p_event text,p_checkout_url text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare op public.provider_operations; pay public.payments; refund_row public.refunds; event_row private.provider_operation_events; total bigint; tips_total bigint;
begin
  select * into op from public.provider_operations where id=p_operation;
  if op.id is null then raise exception 'NOT_FOUND'; end if;
  select * into pay from public.payments where id=op.payment_id;
  perform 1 from public.accounts where id=pay.account_id for update;
  select * into pay from public.payments where id=op.payment_id for update;
  select * into op from public.provider_operations where id=p_operation for update;
  if p_state is null or p_state not in ('WAITING','COMPLETED','FAILED') or p_amount is distinct from op.amount_cents or p_currency is distinct from op.currency
    or p_provider_id is null or length(p_provider_id) not between 1 and 200 or (op.provider_id is not null and op.provider_id<>p_provider_id) then raise exception 'PROVIDER_VERIFICATION_FAILED'; end if;
  if p_lease is not null and p_lease is distinct from op.lease_token then raise exception 'LEASE_CONFLICT'; end if;
  if p_event is null or length(p_event) not between 1 and 200 then raise exception 'INVALID_PROVIDER_EVENT'; end if;
  select * into event_row from private.provider_operation_events where method=op.method and event_id=p_event;
  if event_row.event_id is not null then
    if event_row.operation_id<>op.id or event_row.state<>p_state or event_row.amount_cents<>p_amount or event_row.currency<>p_currency then raise exception 'PROVIDER_EVENT_MISMATCH'; end if;
    return jsonb_build_object('id',op.id,'state',op.state,'checkout_url',op.checkout_url);
  end if;
  if op.state in ('COMPLETED','FAILED') and op.state<>p_state then
    if p_state='WAITING' then return jsonb_build_object('id',op.id,'state',op.state); end if;
    raise exception 'PROVIDER_TERMINAL_CONFLICT';
  end if;
  if p_checkout_url is not null and (length(p_checkout_url)>2048 or p_checkout_url !~ '^https://(checkout\.stripe\.com/|online\.satispay\.com/|staging-online\.satispay\.com/)') then raise exception 'INVALID_PROVIDER_URL'; end if;
  insert into private.provider_operation_events(method,event_id,operation_id,state,amount_cents,currency) values(op.method,p_event,op.id,p_state,p_amount,p_currency);
  if op.kind='PAYMENT' then
    if pay.status='PENDING' and p_state in ('COMPLETED','FAILED') then
      update public.payments set provider_id=p_provider_id,status=case when p_state='COMPLETED' then 'COMPLETED'::public.payment_status else 'FAILED'::public.payment_status end,
        completed_at=case when p_state='COMPLETED' then now() end where id=pay.id;
      if p_state='COMPLETED' and pay.tip_cents>0 then insert into public.tips(venue_id,payment_id,amount_cents) values(pay.venue_id,pay.id,pay.tip_cents); end if;
      perform private.refresh_account_payment_status(pay.account_id);
    elsif pay.status='PENDING' then update public.payments set provider_id=p_provider_id where id=pay.id; end if;
  else
    select * into refund_row from public.refunds where id=op.refund_id for update;
    if refund_row.status='PENDING' and p_state in ('COMPLETED','FAILED') then
      update public.refunds set provider_id=p_provider_id,status=case when p_state='COMPLETED' then 'COMPLETED'::public.refund_status else 'FAILED'::public.refund_status end,
        completed_at=case when p_state='COMPLETED' then now() end where id=refund_row.id;
      if p_state='COMPLETED' then
        select coalesce(sum(amount_cents),0),coalesce(sum(tip_cents),0) into total,tips_total from public.refunds where original_payment_id=pay.id and status='COMPLETED';
        update public.payments set status=case when total=pay.amount_cents and tips_total=pay.tip_cents then 'REFUNDED'::public.payment_status else 'PARTIALLY_REFUNDED'::public.payment_status end where id=pay.id;
      end if;
    elsif refund_row.status='PENDING' then update public.refunds set provider_id=p_provider_id where id=refund_row.id; end if;
  end if;
  update public.provider_operations set provider_id=p_provider_id,state=p_state,checkout_url=coalesce(p_checkout_url,checkout_url),lease_until=null,lease_token=null,last_error=null,updated_at=now() where id=op.id;
  perform private.audit('PROVIDER_RESULT_VERIFIED','provider_operations',op.id,op.venue_id,null,jsonb_build_object('state',p_state,'payment_id',pay.id));
  return jsonb_build_object('id',op.id,'state',p_state,'checkout_url',coalesce(p_checkout_url,op.checkout_url));
end $$;
grant execute on function public.finish_provider_operation(uuid,uuid,text,text,bigint,text,text,text) to service_role;

create function public.release_provider_lease(p_operation uuid,p_lease uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  -- Unknown HTTP outcomes stay reserved. The same operation/key will be reconciled.
  update public.provider_operations set lease_until=null,lease_token=null,state='WAITING',last_error='REMOTE_OUTCOME_UNKNOWN',updated_at=now()
    where id=p_operation and lease_token=p_lease and state='IN_FLIGHT';
end $$;
grant execute on function public.release_provider_lease(uuid,uuid) to service_role;
commit;
