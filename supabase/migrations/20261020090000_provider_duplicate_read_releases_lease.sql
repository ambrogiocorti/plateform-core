-- Staging finding (2026-10-19): a repeated provider read whose event was already recorded (for
-- example a second 'read:<id>:WAITING') returned before releasing the caller's lease, leaving the
-- operation IN_FLIGHT for 45 seconds; webhooks, the Satispay callback and the cashier's check got
-- OPERATION_IN_PROGRESS meanwhile. Both early returns now release the lease the caller holds.
-- The Satispay sandbox serves both staging-online. and staging.online. hosts; the checkout URL
-- check now matches the Edge Function allowlist.
-- Body otherwise identical to 20261005140800_step6_refund_reopens_balance.sql.

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
    -- A repeated read of an event already recorded still ends the caller's attempt: release its
    -- lease and leave IN_FLIGHT, or webhooks and the cashier's check wait for the lease to expire.
    if p_lease is not null then
      update public.provider_operations
      set state=case when state='IN_FLIGHT' then event_row.state else state end,
          lease_until=null,
          lease_token=null,
          updated_at=now()
      where id=op.id
      returning * into op;
    end if;
    return jsonb_build_object('id',op.id,'state',op.state,'checkout_url',op.checkout_url);
  end if;

  if op.state in ('COMPLETED','FAILED') and op.state<>p_state then
    if p_state='WAITING' then
      if p_lease is not null then
        update public.provider_operations
        set lease_until=null, lease_token=null, updated_at=now()
        where id=op.id;
      end if;
      return jsonb_build_object('id',op.id,'state',op.state);
    end if;
    raise exception 'PROVIDER_TERMINAL_CONFLICT';
  end if;

  if p_checkout_url is not null
     and (
       length(p_checkout_url)>2048
       or p_checkout_url !~ '^https://(checkout\.stripe\.com/|online\.satispay\.com/|staging-online\.satispay\.com/|staging\.online\.satispay\.com/)'
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
