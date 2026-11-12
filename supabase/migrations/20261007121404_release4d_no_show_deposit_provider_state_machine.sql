
alter table private.reservation_deposit_no_show_actions
  add column if not exists next_attempt_at timestamptz not null default clock_timestamp(),
  add column if not exists max_attempts integer not null default 12
    check(max_attempts between 1 and 100);

alter table private.reservation_deposit_no_show_actions
  drop constraint if exists reservation_deposit_no_show_actions_state_check;

alter table private.reservation_deposit_no_show_actions
  add constraint reservation_deposit_no_show_actions_state_check
  check(state in (
    'MANUAL_REQUIRED','RETAINED','QUEUED','IN_FLIGHT','WAITING',
    'COMPLETED','FAILED','RECONCILIATION_REQUIRED'
  ));

drop index if exists private.reservation_deposit_no_show_actions_queue_idx;
create index reservation_deposit_no_show_actions_queue_idx
on private.reservation_deposit_no_show_actions(state,next_attempt_at,created_at,id)
where state in ('QUEUED','WAITING');

create table if not exists private.reservation_deposit_no_show_provider_events(
  provider text not null check(provider in ('STRIPE','SATISPAY')),
  event_id text not null,
  action_id uuid not null
    references private.reservation_deposit_no_show_actions(id),
  state text not null check(state in ('WAITING','COMPLETED','FAILED')),
  amount_cents bigint not null check(amount_cents>0),
  currency text not null check(currency='EUR'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(provider,event_id)
);

alter table private.reservation_deposit_no_show_provider_events enable row level security;
revoke all on private.reservation_deposit_no_show_provider_events
from public,anon,authenticated;

create or replace function public.claim_reservation_deposit_no_show_action(
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_action private.reservation_deposit_no_show_actions;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'INVALID_LEASE';
  end if;

  update private.reservation_deposit_no_show_actions
  set state=case
        when provider_refund_id is null then 'RECONCILIATION_REQUIRED'
        else 'WAITING'
      end,
      lease_token=null,
      lease_until=null,
      next_attempt_at=case
        when provider_refund_id is not null then clock_timestamp()
        else next_attempt_at
      end,
      last_error_code='REMOTE_OUTCOME_UNKNOWN',
      updated_at=clock_timestamp()
  where state='IN_FLIGHT'
    and lease_until<clock_timestamp();

  select *
  into v_action
  from private.reservation_deposit_no_show_actions
  where state in ('QUEUED','WAITING')
    and next_attempt_at<=clock_timestamp()
    and attempts<max_attempts
  order by next_attempt_at,created_at,id
  for update skip locked
  limit 1;

  if v_action.id is null then
    return jsonb_build_object('status','IDLE');
  end if;

  update private.reservation_deposit_no_show_actions
  set state='IN_FLIGHT',
      attempts=attempts+1,
      lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      updated_at=clock_timestamp()
  where id=v_action.id
  returning * into v_action;

  return jsonb_build_object(
    'status','CLAIMED',
    'id',v_action.id,
    'lease_token',v_action.lease_token,
    'attempt',v_action.attempts,
    'max_attempts',v_action.max_attempts,
    'venue_id',v_action.venue_id,
    'reservation_id',v_action.reservation_id,
    'deposit_id',v_action.deposit_id,
    'provider',v_action.provider,
    'provider_payment_id',v_action.provider_payment_id,
    'provider_refund_id',v_action.provider_refund_id,
    'amount_cents',v_action.requested_refund_cents,
    'currency','EUR',
    'provider_idempotency_key',v_action.id
  );
end
$$;

revoke all on function public.claim_reservation_deposit_no_show_action(integer)
from public,anon,authenticated;
grant execute on function public.claim_reservation_deposit_no_show_action(integer)
to service_role,postgres;

create or replace function public.finish_reservation_deposit_no_show_action(
  p_action uuid,
  p_lease uuid,
  p_provider_refund_id text,
  p_state text,
  p_amount bigint,
  p_currency text,
  p_event text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_action private.reservation_deposit_no_show_actions;
  v_dep public.reservation_deposits;
  v_event private.reservation_deposit_no_show_provider_events;
  v_new_refunded bigint;
begin
  if p_action is null
     or p_lease is null
     or p_state not in ('WAITING','COMPLETED','FAILED')
     or p_amount is null
     or p_amount<=0
     or p_currency<>'EUR'
     or p_event is null
     or length(p_event) not between 1 and 240
     or (p_provider_refund_id is not null and length(p_provider_refund_id) not between 1 and 240)
     or (p_error_code is not null and length(p_error_code) not between 1 and 160)
  then
    raise exception 'INVALID_DEPOSIT_REFUND_RESULT';
  end if;

  select * into v_action
  from private.reservation_deposit_no_show_actions
  where id=p_action
  for update;

  if v_action.id is null then raise exception 'NOT_FOUND'; end if;
  if v_action.state<>'IN_FLIGHT'
     or v_action.lease_token is distinct from p_lease then
    raise exception 'LEASE_CONFLICT';
  end if;

  if v_action.provider is null
     or v_action.provider_payment_id is null
     or p_amount is distinct from v_action.requested_refund_cents
     or p_amount<=0
     or (
       v_action.provider_refund_id is not null
       and p_provider_refund_id is distinct from v_action.provider_refund_id
     )
     or (
       p_state in ('WAITING','COMPLETED')
       and p_provider_refund_id is null
     )
  then
    raise exception 'PROVIDER_VERIFICATION_FAILED';
  end if;

  select * into v_event
  from private.reservation_deposit_no_show_provider_events
  where provider=v_action.provider
    and event_id=p_event;

  if v_event.event_id is not null then
    if v_event.action_id<>v_action.id
       or v_event.state<>p_state
       or v_event.amount_cents<>p_amount
       or v_event.currency<>p_currency
    then
      raise exception 'PROVIDER_EVENT_MISMATCH';
    end if;

    return jsonb_build_object(
      'id',v_action.id,
      'state',v_action.state,
      'duplicate_event',true
    );
  end if;

  insert into private.reservation_deposit_no_show_provider_events(
    provider,event_id,action_id,state,amount_cents,currency
  ) values(
    v_action.provider,p_event,v_action.id,p_state,p_amount,p_currency
  );

  if p_state='COMPLETED' then
    select * into v_dep
    from public.reservation_deposits
    where id=v_action.deposit_id
    for update;

    if v_dep.id is null
       or v_dep.status not in ('COMPLETED','PARTIALLY_REFUNDED')
       or v_dep.refunded_amount_cents+v_action.requested_refund_cents>v_dep.amount_cents
    then
      raise exception 'DEPOSIT_REFUND_CONFLICT';
    end if;

    v_new_refunded:=v_dep.refunded_amount_cents+v_action.requested_refund_cents;

    update public.reservation_deposits
    set refunded_amount_cents=v_new_refunded,
        status=case
          when v_new_refunded=v_dep.amount_cents then 'REFUNDED'
          else 'PARTIALLY_REFUNDED'
        end
    where id=v_dep.id;

    update private.reservation_deposit_no_show_actions
    set state='COMPLETED',
        provider_refund_id=p_provider_refund_id,
        lease_token=null,
        lease_until=null,
        last_error_code=null,
        completed_at=clock_timestamp(),
        updated_at=clock_timestamp()
    where id=v_action.id;

  elsif p_state='WAITING' then
    update private.reservation_deposit_no_show_actions
    set state='WAITING',
        provider_refund_id=p_provider_refund_id,
        lease_token=null,
        lease_until=null,
        next_attempt_at=clock_timestamp()+interval '30 seconds',
        last_error_code=null,
        updated_at=clock_timestamp()
    where id=v_action.id;

  else
    update private.reservation_deposit_no_show_actions
    set state='FAILED',
        provider_refund_id=coalesce(p_provider_refund_id,provider_refund_id),
        lease_token=null,
        lease_until=null,
        last_error_code=coalesce(p_error_code,'PROVIDER_REFUND_FAILED'),
        completed_at=clock_timestamp(),
        updated_at=clock_timestamp()
    where id=v_action.id;

    insert into public.notifications(
      venue_id,recipient_role,category,priority,title,resource_type,resource_id
    )
    select
      venue_id,'ADMIN','DEPOSIT_REFUND_FAILED','WARNING',
      'Rimborso caparra no-show non riuscito',
      'reservation_deposit_no_show_actions',id
    from private.reservation_deposit_no_show_actions
    where id=v_action.id;
  end if;

  perform private.audit(
    'RESERVATION_DEPOSIT_NO_SHOW_PROVIDER_RESULT',
    'reservation_deposit_no_show_actions',
    v_action.id,
    v_action.venue_id,
    null,
    jsonb_build_object(
      'state',p_state,
      'deposit_id',v_action.deposit_id,
      'amount_cents',p_amount,
      'provider',v_action.provider
    )
  );

  return jsonb_build_object(
    'id',v_action.id,
    'state',p_state,
    'provider_refund_id',p_provider_refund_id
  );
end
$$;

revoke all on function public.finish_reservation_deposit_no_show_action(
  uuid,uuid,text,text,bigint,text,text,text
) from public,anon,authenticated;
grant execute on function public.finish_reservation_deposit_no_show_action(
  uuid,uuid,text,text,bigint,text,text,text
) to service_role,postgres;

create or replace function public.release_reservation_deposit_no_show_action_unknown(
  p_action uuid,
  p_lease uuid,
  p_error_code text default 'REMOTE_OUTCOME_UNKNOWN'
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_action private.reservation_deposit_no_show_actions;
begin
  if p_action is null
     or p_lease is null
     or p_error_code is null
     or length(p_error_code) not between 1 and 160
  then
    raise exception 'INVALID_RECONCILIATION_RESULT';
  end if;

  select * into v_action
  from private.reservation_deposit_no_show_actions
  where id=p_action
  for update;

  if v_action.id is null then raise exception 'NOT_FOUND'; end if;
  if v_action.state<>'IN_FLIGHT'
     or v_action.lease_token is distinct from p_lease then
    raise exception 'LEASE_CONFLICT';
  end if;

  update private.reservation_deposit_no_show_actions
  set state='RECONCILIATION_REQUIRED',
      lease_token=null,
      lease_until=null,
      last_error_code=p_error_code,
      updated_at=clock_timestamp()
  where id=v_action.id;

  insert into public.notifications(
    venue_id,recipient_role,category,priority,title,resource_type,resource_id
  ) values(
    v_action.venue_id,'ADMIN','DEPOSIT_REFUND_RECONCILIATION','WARNING',
    'Rimborso caparra da riconciliare',
    'reservation_deposit_no_show_actions',v_action.id
  );

  perform private.audit(
    'RESERVATION_DEPOSIT_NO_SHOW_RECONCILIATION_REQUIRED',
    'reservation_deposit_no_show_actions',
    v_action.id,
    v_action.venue_id,
    null,
    jsonb_build_object(
      'deposit_id',v_action.deposit_id,
      'provider',v_action.provider,
      'error_code',p_error_code
    )
  );

  return jsonb_build_object(
    'id',v_action.id,
    'state','RECONCILIATION_REQUIRED'
  );
end
$$;

revoke all on function public.release_reservation_deposit_no_show_action_unknown(uuid,uuid,text)
from public,anon,authenticated;
grant execute on function public.release_reservation_deposit_no_show_action_unknown(uuid,uuid,text)
to service_role,postgres;

do $$
begin
  if not exists(
    select 1 from vault.decrypted_secrets
    where name='plateform_no_show_deposit_worker_token'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32),'hex'),
      'plateform_no_show_deposit_worker_token',
      'Internal token for reservation deposit no-show refund worker',
      null
    );
  end if;
end
$$;

create or replace function public.invoke_reservation_deposit_no_show_worker(
  p_max_jobs integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_token text;
  v_request_id bigint;
begin
  if p_max_jobs is null or p_max_jobs not between 1 and 25 then
    raise exception 'INVALID_MAX_JOBS';
  end if;

  select decrypted_secret
  into v_token
  from vault.decrypted_secrets
  where name='plateform_no_show_deposit_worker_token'
  order by created_at desc
  limit 1;

  if v_token is null or length(v_token)<32 then
    raise exception 'NO_SHOW_DEPOSIT_WORKER_TOKEN_MISSING';
  end if;

  v_request_id:=net.http_post(
    url:='https://abdxvlykasqmknexxhjo.supabase.co/functions/v1/reservation-deposit-no-show-worker',
    body:=jsonb_build_object('max_jobs',p_max_jobs),
    params:='{}'::jsonb,
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-plateform-worker-token',v_token
    ),
    timeout_milliseconds:=10000
  );

  return jsonb_build_object(
    'queued',true,
    'request_id',v_request_id
  );
end
$$;

revoke all on function public.invoke_reservation_deposit_no_show_worker(integer)
from public,anon,authenticated;
grant execute on function public.invoke_reservation_deposit_no_show_worker(integer)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values
 ('public.claim_reservation_deposit_no_show_action(integer)','service_role'),
 ('public.finish_reservation_deposit_no_show_action(uuid,uuid,text,text,bigint,text,text,text)','service_role'),
 ('public.release_reservation_deposit_no_show_action_unknown(uuid,uuid,text)','service_role'),
 ('public.invoke_reservation_deposit_no_show_worker(integer)','service_role')
on conflict do nothing;

select cron.schedule(
  'plateform-reservation-deposit-no-show-refunds',
  '* * * * *',
  'select public.invoke_reservation_deposit_no_show_worker(10);'
)
where not exists(
  select 1 from cron.job
  where jobname='plateform-reservation-deposit-no-show-refunds'
);

insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_NO_SHOW_DEPOSIT_PROVIDER_STATE_MACHINE',
  'REGRESSION',
  true,
  'No-show deposit refunds are leased to a service-only provider worker, only mutate deposit refunded state after verified provider completion, poll known remote refund ids safely and require reconciliation for unknown outcomes.'
)
on conflict(key) do nothing;
