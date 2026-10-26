
create table private.reservation_deposit_no_show_actions(
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references public.reservation_deposits(id),
  reservation_id uuid not null references public.reservations(id),
  venue_id uuid not null references public.venues(id),
  reservation_version bigint not null,
  policy text not null check(policy in ('MANUAL','RETAIN','REFUND_FULL','PARTIAL_REFUND')),
  refund_bps integer,
  target_refund_cents bigint not null default 0 check(target_refund_cents>=0),
  requested_refund_cents bigint not null default 0 check(requested_refund_cents>=0),
  provider text check(provider is null or provider in ('STRIPE','SATISPAY')),
  provider_payment_id text,
  provider_refund_id text,
  state text not null check(state in (
    'MANUAL_REQUIRED','RETAINED','QUEUED','IN_FLIGHT',
    'COMPLETED','FAILED','RECONCILIATION_REQUIRED'
  )),
  attempts integer not null default 0 check(attempts>=0),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique(deposit_id,reservation_version),
  check(
    (policy='PARTIAL_REFUND' and refund_bps between 1 and 9999)
    or (policy<>'PARTIAL_REFUND' and refund_bps is null)
  ),
  check(
    (state='IN_FLIGHT' and lease_token is not null and lease_until is not null)
    or (state<>'IN_FLIGHT')
  )
);

alter table private.reservation_deposit_no_show_actions enable row level security;
revoke all on private.reservation_deposit_no_show_actions from public,anon,authenticated;

create index reservation_deposit_no_show_actions_queue_idx
on private.reservation_deposit_no_show_actions(state,created_at,id)
where state in ('QUEUED','FAILED');

create index reservation_deposit_no_show_actions_reservation_idx
on private.reservation_deposit_no_show_actions(reservation_id,created_at desc);

create or replace function private.enqueue_reservation_no_show_deposit_action(
  p_reservation uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_res public.reservations;
  v_rule public.service_booking_rules;
  v_dep public.reservation_deposits;
  v_action private.reservation_deposit_no_show_actions;
  v_policy text;
  v_target bigint:=0;
  v_requested bigint:=0;
  v_state text;
begin
  select * into v_res
  from public.reservations
  where id=p_reservation;

  if v_res.id is null or v_res.status<>'NO_SHOW' then
    return null;
  end if;

  select * into v_rule
  from public.service_booking_rules
  where service_id=v_res.service_id
    and venue_id=v_res.venue_id;

  if v_rule.service_id is null then
    return null;
  end if;

  select * into v_dep
  from public.reservation_deposits
  where reservation_id=v_res.id
    and status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
  order by created_at desc,id desc
  limit 1;

  if v_dep.id is null or v_dep.status='REFUNDED' then
    return null;
  end if;

  v_policy:=v_rule.deposit_no_show_action;

  if v_policy='MANUAL' then
    v_state:='MANUAL_REQUIRED';

  elsif v_policy='RETAIN' then
    v_state:='RETAINED';

  elsif v_policy='REFUND_FULL' then
    v_target:=v_dep.amount_cents;
    v_requested:=greatest(v_target-v_dep.refunded_amount_cents,0);
    v_state:=case
      when v_requested=0 then 'COMPLETED'
      when v_dep.provider is null or v_dep.provider_reference is null
        then 'MANUAL_REQUIRED'
      else 'QUEUED'
    end;

  elsif v_policy='PARTIAL_REFUND' then
    v_target:=round(
      v_dep.amount_cents::numeric
      * v_rule.deposit_no_show_refund_bps::numeric
      / 10000
    )::bigint;
    v_requested:=greatest(v_target-v_dep.refunded_amount_cents,0);
    v_state:=case
      when v_requested=0 then 'COMPLETED'
      when v_dep.provider is null or v_dep.provider_reference is null
        then 'MANUAL_REQUIRED'
      else 'QUEUED'
    end;
  else
    raise exception 'INVALID_NO_SHOW_DEPOSIT_POLICY';
  end if;

  insert into private.reservation_deposit_no_show_actions(
    deposit_id,reservation_id,venue_id,reservation_version,
    policy,refund_bps,target_refund_cents,requested_refund_cents,
    provider,provider_payment_id,state,last_error_code,completed_at
  ) values(
    v_dep.id,v_res.id,v_res.venue_id,v_res.version,
    v_policy,
    case when v_policy='PARTIAL_REFUND' then v_rule.deposit_no_show_refund_bps end,
    v_target,v_requested,
    v_dep.provider,v_dep.provider_reference,v_state,
    case
      when v_state='MANUAL_REQUIRED'
       and v_policy in ('REFUND_FULL','PARTIAL_REFUND')
       and (v_dep.provider is null or v_dep.provider_reference is null)
      then 'PROVIDER_REFERENCE_MISSING'
    end,
    case when v_state in ('RETAINED','COMPLETED') then clock_timestamp() end
  )
  on conflict(deposit_id,reservation_version) do nothing
  returning * into v_action;

  if v_action.id is null then
    select * into v_action
    from private.reservation_deposit_no_show_actions
    where deposit_id=v_dep.id
      and reservation_version=v_res.version;
  end if;

  if v_action.state='MANUAL_REQUIRED'
     and not exists(
       select 1 from public.notifications n
       where n.resource_type='reservation_deposit_no_show_actions'
         and n.resource_id=v_action.id
         and n.category='DEPOSIT_NO_SHOW_ACTION_REQUIRED'
     )
  then
    insert into public.notifications(
      venue_id,recipient_role,category,priority,title,
      resource_type,resource_id
    ) values(
      v_res.venue_id,'ADMIN','DEPOSIT_NO_SHOW_ACTION_REQUIRED',
      'WARNING',
      'Azione sulla caparra del no-show da verificare',
      'reservation_deposit_no_show_actions',v_action.id
    );
  end if;

  perform private.audit(
    'RESERVATION_DEPOSIT_NO_SHOW_POLICY',
    'reservation_deposit_no_show_actions',
    v_action.id,
    v_action.venue_id,
    null,
    jsonb_build_object(
      'reservation_id',v_action.reservation_id,
      'deposit_id',v_action.deposit_id,
      'policy',v_action.policy,
      'state',v_action.state,
      'target_refund_cents',v_action.target_refund_cents,
      'requested_refund_cents',v_action.requested_refund_cents
    )
  );

  return jsonb_build_object(
    'id',v_action.id,
    'deposit_id',v_action.deposit_id,
    'reservation_id',v_action.reservation_id,
    'policy',v_action.policy,
    'state',v_action.state,
    'target_refund_cents',v_action.target_refund_cents,
    'requested_refund_cents',v_action.requested_refund_cents
  );
end
$$;

revoke all on function private.enqueue_reservation_no_show_deposit_action(uuid)
from public,anon,authenticated;

create or replace function private.reservation_no_show_deposit_policy_trigger()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if old.status is distinct from new.status and new.status='NO_SHOW' then
    perform private.enqueue_reservation_no_show_deposit_action(new.id);
  end if;
  return new;
end
$$;

revoke all on function private.reservation_no_show_deposit_policy_trigger()
from public,anon,authenticated;

drop trigger if exists reservation_no_show_deposit_policy on public.reservations;
create trigger reservation_no_show_deposit_policy
after update of status on public.reservations
for each row
execute function private.reservation_no_show_deposit_policy_trigger();

insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_NO_SHOW_DEPOSIT_POLICY',
  'REGRESSION',
  true,
  'A NO_SHOW snapshots the configured deposit action; MANUAL and RETAIN never call a provider, while FULL/PARTIAL create an idempotent queued refund amount without changing deposit refund state before provider confirmation.'
)
on conflict(key) do nothing;
