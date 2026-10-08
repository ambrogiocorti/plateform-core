create or replace function private.effective_payment_allocation(p_allocation uuid)
returns bigint
language sql
stable
security definer
set search_path=''
as $$
  with target as (
    select
      a.id,
      a.payment_id,
      a.amount_cents,
      a.created_at,
      p.amount_cents as payment_amount_cents,
      p.status,
      greatest(
        p.amount_cents - coalesce((
          select sum(r.amount_cents)
          from public.refunds r
          where r.original_payment_id=p.id
            and r.status='COMPLETED'
        ),0),
        0
      )::bigint as effective_principal_cents
    from public.payment_unit_allocations a
    join public.payments p on p.id=a.payment_id
    where a.id=p_allocation
  ),
  positioned as (
    select
      t.*,
      coalesce((
        select sum(a2.amount_cents)
        from public.payment_unit_allocations a2
        where a2.payment_id=t.payment_id
          and (a2.created_at,a2.id)<(t.created_at,t.id)
      ),0)::bigint as prior_allocated_cents
    from target t
  )
  select coalesce(
    case
      when status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED') then
        greatest(
          least(amount_cents, effective_principal_cents-prior_allocated_cents),
          0
        )::bigint
      else 0::bigint
    end,
    0::bigint
  )
  from positioned
$$;

create or replace function private.billing_balance(p_account uuid)
returns table(
  id uuid,
  order_item_id uuid,
  unit_number integer,
  gross_cents bigint,
  discount_cents bigint,
  net_cents bigint,
  paid_cents bigint,
  pending_cents bigint,
  available_cents bigint
)
language sql
stable
security definer
set search_path=''
as $$
  select
    u.id,
    u.order_item_id,
    u.unit_number,
    u.gross_cents,
    u.discount_cents,
    u.gross_cents-u.discount_cents,
    coalesce(s.paid,0)::bigint,
    coalesce(s.pending,0)::bigint,
    (u.gross_cents-u.discount_cents-coalesce(s.paid,0)-coalesce(s.pending,0))::bigint
  from public.billing_units u
  left join lateral (
    select
      sum(private.effective_payment_allocation(a.id))
        filter(where p.status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')) as paid,
      sum(a.amount_cents)
        filter(where p.status='PENDING') as pending
    from public.payment_unit_allocations a
    join public.payments p on p.id=a.payment_id
    where a.billing_unit_id=u.id
  ) s on true
  where u.account_id=p_account
    and u.voided_at is null
$$;

create or replace function private.guard_billing_unit()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare assigned bigint;
begin
  if tg_op='DELETE'
     or (to_jsonb(new)-array['account_id','discount_cents','voided_at'])
        is distinct from
        (to_jsonb(old)-array['account_id','discount_cents','voided_at'])
  then
    raise exception 'IMMUTABLE_BILLING_ORIGIN';
  end if;

  if old.voided_at is not null and new.voided_at is distinct from old.voided_at then
    raise exception 'IMMUTABLE_BILLING_ORIGIN';
  end if;

  select coalesce(sum(
    case
      when p.status='PENDING' then a.amount_cents
      when p.status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
        then private.effective_payment_allocation(a.id)
      else 0
    end
  ),0)
  into assigned
  from public.payment_unit_allocations a
  join public.payments p on p.id=a.payment_id
  where a.billing_unit_id=old.id;

  if (new.voided_at is not null and assigned>0)
     or new.gross_cents-new.discount_cents<assigned
  then
    raise exception 'SETTLED_ITEM_REQUIRES_CORRECTION';
  end if;

  return new;
end
$$;

create or replace function private.check_unit_allocation()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  unit public.billing_units;
  assigned bigint;
  payment_amount bigint;
begin
  select * into unit
  from public.billing_units
  where id=new.billing_unit_id
  for update;

  select amount_cents into payment_amount
  from public.payments
  where id=new.payment_id;

  if new.amount_cents
     + coalesce((
       select sum(amount_cents)
       from public.payment_unit_allocations
       where payment_id=new.payment_id
     ),0)
     > payment_amount
  then
    raise exception 'ALLOCATION_AMOUNT_MISMATCH';
  end if;

  if exists(
    select 1
    from public.payments
    where id=new.payment_id
      and status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
  ) then
    select coalesce(sum(
      case
        when p.status='PENDING' then a.amount_cents
        when p.status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
          then private.effective_payment_allocation(a.id)
        else 0
      end
    ),0)
    into assigned
    from public.payment_unit_allocations a
    join public.payments p on p.id=a.payment_id
    where a.billing_unit_id=unit.id;

    if unit.voided_at is not null
       or assigned+new.amount_cents>unit.gross_cents-unit.discount_cents
    then
      raise exception 'ITEM_ALREADY_ALLOCATED';
    end if;
  end if;

  return new;
end
$$;

create or replace function private.assert_payment_units()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  payment public.payments;
  unit public.billing_units;
  assigned bigint;
begin
  select * into payment
  from public.payments
  where id=new.id;

  if payment.status not in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED') then
    return null;
  end if;

  if coalesce((
    select sum(amount_cents)
    from public.payment_unit_allocations
    where payment_id=payment.id
  ),0)<>payment.amount_cents
  then
    raise exception 'ALLOCATION_AMOUNT_MISMATCH';
  end if;

  for unit in
    select u.*
    from public.billing_units u
    where id in (
      select billing_unit_id
      from public.payment_unit_allocations
      where payment_id=payment.id
    )
    order by id
    for update
  loop
    select coalesce(sum(
      case
        when p.status='PENDING' then a.amount_cents
        when p.status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
          then private.effective_payment_allocation(a.id)
        else 0
      end
    ),0)
    into assigned
    from public.payment_unit_allocations a
    join public.payments p on p.id=a.payment_id
    where a.billing_unit_id=unit.id;

    if unit.voided_at is not null
       or assigned>unit.gross_cents-unit.discount_cents
    then
      raise exception 'ITEM_ALREADY_ALLOCATED';
    end if;
  end loop;

  return null;
end
$$;

create or replace function public.create_refund(
  p_payment uuid,
  p_amount bigint,
  p_tip bigint,
  p_reason text,
  p_step_up uuid,
  p_key uuid,
  p_register uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  p public.payments;
  already bigint;
  tips_already bigint;
  ref uuid;
  result jsonb;
  target_register uuid;
  target_session uuid;
begin
  select * into p from public.payments where id=p_payment;
  if p.id is null then raise exception 'NOT_FOUND'; end if;

  perform private.authorize(p.venue_id,array['ADMIN']::public.user_role[]);
  perform 1 from public.accounts where id=p.account_id for update;
  select * into p from public.payments where id=p_payment for update;

  result:=private.idempotency_begin(
    'refund',
    p_key,
    jsonb_build_object(
      'payment',p_payment,
      'amount',p_amount,
      'tip',p_tip,
      'reason',p_reason,
      'register',p_register
    )
  );
  if result is not null then return result; end if;

  perform private.consume_step_up(p_step_up,'REFUND',p.id);

  if p.status not in ('COMPLETED','PARTIALLY_REFUNDED') then
    raise exception 'PAYMENT_NOT_REFUNDABLE';
  end if;

  if p_reason is null or length(trim(p_reason)) not between 3 and 2000 then
    raise exception 'REASON_REQUIRED';
  end if;

  select
    coalesce(sum(amount_cents),0),
    coalesce(sum(tip_cents),0)
  into already,tips_already
  from public.refunds
  where original_payment_id=p.id
    and status not in ('FAILED','REJECTED');

  if p_amount is null
     or p_amount<0
     or p_tip is null
     or p_tip<0
     or p_amount+p_tip<=0
     or already+p_amount>p.amount_cents
     or tips_already+p_tip>p.tip_cents
  then
    raise exception 'INVALID_REFUND_AMOUNT';
  end if;

  target_register:=coalesce(p_register,p.cash_register_id);

  if not private.can_use_register(target_register)
     or not exists(
       select 1
       from public.cash_registers
       where id=target_register
         and venue_id=p.venue_id
         and active
         and status='OPEN'
     )
  then
    raise exception 'REGISTER_NOT_OPEN';
  end if;

  select s.id into target_session
  from public.service_sessions s
  join public.cash_register_sessions c on c.service_session_id=s.id
  where c.cash_register_id=target_register
    and c.closed_at is null
    and s.status='OPEN'
  for update of s;

  if target_session is null then
    raise exception 'SERVICE_NOT_OPEN';
  end if;

  insert into public.refunds(
    venue_id,
    original_payment_id,
    amount_cents,
    tip_cents,
    method,
    authorized_by,
    status,
    reason,
    idempotency_key,
    completed_at,
    cash_register_id,
    service_session_id,
    operator_user_id
  )
  values(
    p.venue_id,
    p.id,
    p_amount,
    p_tip,
    p.method,
    private.effective_user_id(),
    case
      when p.method in ('STRIPE','SATISPAY_API') then 'PENDING'::public.refund_status
      else 'COMPLETED'::public.refund_status
    end,
    trim(p_reason),
    p_key,
    case when p.method not in ('STRIPE','SATISPAY_API') then now() end,
    target_register,
    target_session,
    private.effective_user_id()
  )
  returning id into ref;

  if p.method not in ('STRIPE','SATISPAY_API') then
    update public.payments
    set status=case
      when already+p_amount=p.amount_cents and tips_already+p_tip=p.tip_cents
        then 'REFUNDED'::public.payment_status
      else 'PARTIALLY_REFUNDED'::public.payment_status
    end
    where id=p.id;

    perform private.refresh_account_payment_status(p.account_id);
  end if;

  return private.idempotency_finish(
    'refund',
    p_key,
    jsonb_build_object(
      'id',ref,
      'status',
      case
        when p.method in ('STRIPE','SATISPAY_API') then 'PENDING'
        else 'COMPLETED'
      end
    )
  );
end
$$;

create or replace function public.finish_provider_operation(
  p_operation uuid,
  p_lease uuid,
  p_provider_id text,
  p_state text,
  p_amount bigint,
  p_currency text,
  p_event text,
  p_checkout_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  op public.provider_operations;
  pay public.payments;
  refund_row public.refunds;
  event_row private.provider_operation_events;
  total bigint;
  tips_total bigint;
begin
  select * into op from public.provider_operations where id=p_operation;
  if op.id is null then raise exception 'NOT_FOUND'; end if;

  select * into pay from public.payments where id=op.payment_id;
  perform 1 from public.accounts where id=pay.account_id for update;
  select * into pay from public.payments where id=op.payment_id for update;
  select * into op from public.provider_operations where id=p_operation for update;

  if p_state is null
     or p_state not in ('WAITING','COMPLETED','FAILED')
     or p_amount is distinct from op.amount_cents
     or p_currency is distinct from op.currency
     or p_provider_id is null
     or length(p_provider_id) not between 1 and 200
     or (op.provider_id is not null and op.provider_id<>p_provider_id)
  then
    raise exception 'PROVIDER_VERIFICATION_FAILED';
  end if;

  if p_lease is not null and p_lease is distinct from op.lease_token then
    raise exception 'LEASE_CONFLICT';
  end if;

  if p_event is null or length(p_event) not between 1 and 200 then
    raise exception 'INVALID_PROVIDER_EVENT';
  end if;

  select * into event_row
  from private.provider_operation_events
  where method=op.method and event_id=p_event;

  if event_row.event_id is not null then
    if event_row.operation_id<>op.id
       or event_row.state<>p_state
       or event_row.amount_cents<>p_amount
       or event_row.currency<>p_currency
    then
      raise exception 'PROVIDER_EVENT_MISMATCH';
    end if;
    return jsonb_build_object('id',op.id,'state',op.state,'checkout_url',op.checkout_url);
  end if;

  if op.state in ('COMPLETED','FAILED') and op.state<>p_state then
    if p_state='WAITING' then
      return jsonb_build_object('id',op.id,'state',op.state);
    end if;
    raise exception 'PROVIDER_TERMINAL_CONFLICT';
  end if;

  if p_checkout_url is not null
     and (
       length(p_checkout_url)>2048
       or p_checkout_url !~ '^https://(checkout\.stripe\.com/|online\.satispay\.com/|staging-online\.satispay\.com/)'
     )
  then
    raise exception 'INVALID_PROVIDER_URL';
  end if;

  insert into private.provider_operation_events(
    method,event_id,operation_id,state,amount_cents,currency
  )
  values(op.method,p_event,op.id,p_state,p_amount,p_currency);

  if op.kind='PAYMENT' then
    if pay.status='PENDING' and p_state in ('COMPLETED','FAILED') then
      update public.payments
      set provider_id=p_provider_id,
          status=case
            when p_state='COMPLETED' then 'COMPLETED'::public.payment_status
            else 'FAILED'::public.payment_status
          end,
          completed_at=case when p_state='COMPLETED' then now() end
      where id=pay.id;

      if p_state='COMPLETED' and pay.tip_cents>0 then
        insert into public.tips(venue_id,payment_id,amount_cents)
        values(pay.venue_id,pay.id,pay.tip_cents);
      end if;

      perform private.refresh_account_payment_status(pay.account_id);
    elsif pay.status='PENDING' then
      update public.payments set provider_id=p_provider_id where id=pay.id;
    end if;
  else
    select * into refund_row
    from public.refunds
    where id=op.refund_id
    for update;

    if refund_row.status='PENDING' and p_state in ('COMPLETED','FAILED') then
      update public.refunds
      set provider_id=p_provider_id,
          status=case
            when p_state='COMPLETED' then 'COMPLETED'::public.refund_status
            else 'FAILED'::public.refund_status
          end,
          completed_at=case when p_state='COMPLETED' then now() end
      where id=refund_row.id;

      if p_state='COMPLETED' then
        select
          coalesce(sum(amount_cents),0),
          coalesce(sum(tip_cents),0)
        into total,tips_total
        from public.refunds
        where original_payment_id=pay.id
          and status='COMPLETED';

        update public.payments
        set status=case
          when total=pay.amount_cents and tips_total=pay.tip_cents
            then 'REFUNDED'::public.payment_status
          else 'PARTIALLY_REFUNDED'::public.payment_status
        end
        where id=pay.id;

        perform private.refresh_account_payment_status(pay.account_id);
      end if;
    elsif refund_row.status='PENDING' then
      update public.refunds set provider_id=p_provider_id where id=refund_row.id;
    end if;
  end if;

  update public.provider_operations
  set provider_id=p_provider_id,
      state=p_state,
      checkout_url=coalesce(p_checkout_url,checkout_url),
      lease_until=null,
      lease_token=null,
      last_error=null,
      updated_at=now()
  where id=op.id;

  perform private.audit(
    'PROVIDER_RESULT_VERIFIED',
    'provider_operations',
    op.id,
    op.venue_id,
    null,
    jsonb_build_object('state',p_state,'payment_id',pay.id)
  );

  return jsonb_build_object(
    'id',op.id,
    'state',p_state,
    'checkout_url',coalesce(p_checkout_url,op.checkout_url)
  );
end
$$;

select private.refresh_account_payment_status('c0617658-673d-40f8-b607-894edc4ce9c3'::uuid);
