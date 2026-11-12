create table if not exists private.reservation_deposit_provider_events(
  provider text not null check(provider in ('STRIPE','SATISPAY')),
  event_id text not null check(length(event_id) between 1 and 240),
  deposit_id uuid not null references public.reservation_deposits(id),
  provider_reference text not null check(length(provider_reference) between 1 and 240),
  event_state text not null check(event_state in ('COMPLETED','FAILED')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(provider,event_id)
);

alter table private.reservation_deposit_provider_events enable row level security;
revoke all on table private.reservation_deposit_provider_events from public,anon,authenticated;

create index if not exists reservation_deposit_provider_events_deposit_idx
on private.reservation_deposit_provider_events(deposit_id,created_at desc);

create or replace function public.begin_reservation_deposit(
  p_deposit uuid,
  p_access_token text,
  p_provider text,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_provider text:=upper(trim(p_provider));
  v_deposit public.reservation_deposits;
  v_result jsonb;
begin
  if p_deposit is null
     or p_access_token is null
     or length(p_access_token) not between 32 and 256
     or v_provider not in ('STRIPE','SATISPAY')
     or p_key is null
  then
    raise exception 'INVALID_DEPOSIT_START';
  end if;

  if not private.verify_reservation_deposit_access(p_deposit,p_access_token) then
    raise exception 'DEPOSIT_ACCESS_DENIED' using errcode='42501';
  end if;

  select * into v_deposit
  from public.reservation_deposits
  where id=p_deposit
  for update;

  if v_deposit.id is null then raise exception 'NOT_FOUND'; end if;
  if v_deposit.status<>'PENDING' then raise exception 'DEPOSIT_NOT_PENDING'; end if;
  if v_deposit.expires_at<=clock_timestamp() then raise exception 'DEPOSIT_EXPIRED'; end if;
  if not private.venue_feature_enabled(v_deposit.venue_id,'BOOKING_DEPOSITS') then
    raise exception 'BOOKING_DEPOSITS_DISABLED';
  end if;

  v_result:=private.idempotency_begin(
    'reservation_deposit_start',
    p_key,
    jsonb_build_object(
      'deposit',p_deposit,
      'token_hash',private.deposit_access_token_hash(p_access_token),
      'provider',v_provider
    )
  );
  if v_result is not null then return v_result; end if;

  if v_deposit.provider is not null and v_deposit.provider<>v_provider then
    raise exception 'DEPOSIT_PROVIDER_ALREADY_SELECTED';
  end if;

  if v_deposit.provider is null then
    update public.reservation_deposits
    set provider=v_provider
    where id=v_deposit.id
    returning * into v_deposit;
  end if;

  v_result:=jsonb_build_object(
    'deposit_id',v_deposit.id,
    'reservation_id',v_deposit.reservation_id,
    'venue_id',v_deposit.venue_id,
    'amount_cents',v_deposit.amount_cents,
    'currency',v_deposit.currency,
    'provider',v_deposit.provider,
    'expires_at',v_deposit.expires_at
  );

  return private.idempotency_finish(
    'reservation_deposit_start',p_key,v_result
  );
end
$$;

create or replace function public.bind_reservation_deposit_provider_reference(
  p_deposit uuid,
  p_provider text,
  p_provider_reference text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_provider text:=upper(trim(p_provider));
  v_ref text:=trim(p_provider_reference);
  v_deposit public.reservation_deposits;
begin
  if p_deposit is null
     or v_provider not in ('STRIPE','SATISPAY')
     or v_ref is null
     or length(v_ref) not between 1 and 240
  then
    raise exception 'INVALID_DEPOSIT_PROVIDER_REFERENCE';
  end if;

  select * into v_deposit
  from public.reservation_deposits
  where id=p_deposit
  for update;

  if v_deposit.id is null then raise exception 'NOT_FOUND'; end if;
  if v_deposit.status<>'PENDING' then raise exception 'DEPOSIT_NOT_PENDING'; end if;
  if v_deposit.provider is distinct from v_provider then
    raise exception 'DEPOSIT_PROVIDER_MISMATCH';
  end if;

  if v_deposit.provider_reference is not null then
    if v_deposit.provider_reference<>v_ref then
      raise exception 'IMMUTABLE_PROVIDER_REFERENCE';
    end if;

    return jsonb_build_object(
      'deposit_id',v_deposit.id,
      'provider',v_deposit.provider,
      'provider_reference',v_deposit.provider_reference
    );
  end if;

  update public.reservation_deposits
  set provider_reference=v_ref
  where id=v_deposit.id
  returning * into v_deposit;

  return jsonb_build_object(
    'deposit_id',v_deposit.id,
    'provider',v_deposit.provider,
    'provider_reference',v_deposit.provider_reference
  );
end
$$;

create or replace function public.apply_reservation_deposit_callback(
  p_provider text,
  p_event_id text,
  p_provider_reference text,
  p_state text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_provider text:=upper(trim(p_provider));
  v_state text:=upper(trim(p_state));
  v_ref text:=trim(p_provider_reference);
  v_deposit public.reservation_deposits;
  v_reservation public.reservations;
  v_existing private.reservation_deposit_provider_events;
begin
  if v_provider not in ('STRIPE','SATISPAY')
     or p_event_id is null
     or length(p_event_id) not between 1 and 240
     or v_ref is null
     or length(v_ref) not between 1 and 240
     or v_state not in ('COMPLETED','FAILED')
  then
    raise exception 'INVALID_DEPOSIT_CALLBACK';
  end if;

  select * into v_existing
  from private.reservation_deposit_provider_events
  where provider=v_provider and event_id=p_event_id;

  if v_existing.event_id is not null then
    if v_existing.provider_reference<>v_ref
       or v_existing.event_state<>v_state then
      raise exception 'DEPOSIT_PROVIDER_EVENT_MISMATCH';
    end if;

    select * into v_deposit
    from public.reservation_deposits
    where id=v_existing.deposit_id;

    return jsonb_build_object(
      'deposit_id',v_deposit.id,
      'reservation_id',v_deposit.reservation_id,
      'deposit_status',v_deposit.status,
      'duplicate_event',true
    );
  end if;

  select * into v_deposit
  from public.reservation_deposits
  where provider=v_provider
    and provider_reference=v_ref
  for update;

  if v_deposit.id is null then raise exception 'DEPOSIT_NOT_FOUND'; end if;

  select * into v_reservation
  from public.reservations
  where id=v_deposit.reservation_id
  for update;

  if v_reservation.id is null then raise exception 'RESERVATION_NOT_FOUND'; end if;

  if v_state='COMPLETED' then
    if v_deposit.status='COMPLETED' and v_reservation.status='RESERVED' then
      insert into private.reservation_deposit_provider_events(
        provider,event_id,deposit_id,provider_reference,event_state
      ) values(v_provider,p_event_id,v_deposit.id,v_ref,v_state);

      return jsonb_build_object(
        'deposit_id',v_deposit.id,
        'reservation_id',v_reservation.id,
        'deposit_status','COMPLETED',
        'reservation_status','RESERVED'
      );
    end if;

    if v_deposit.status<>'PENDING'
       or v_reservation.status<>'PENDING_DEPOSIT' then
      raise exception 'DEPOSIT_CALLBACK_OUT_OF_ORDER';
    end if;

    if v_deposit.expires_at<=clock_timestamp() then
      raise exception 'DEPOSIT_EXPIRED';
    end if;

    update public.reservation_deposits
    set status='COMPLETED',
        completed_at=clock_timestamp()
    where id=v_deposit.id
    returning * into v_deposit;

    update public.reservations
    set status='RESERVED'
    where id=v_reservation.id
    returning * into v_reservation;

    update private.reservation_deposit_access
    set revoked_at=clock_timestamp()
    where deposit_id=v_deposit.id and revoked_at is null;

    insert into public.notifications(
      venue_id,recipient_role,category,title,resource_type,resource_id
    ) values(
      v_reservation.venue_id,'HOST','RESERVATION',
      'Caparra ricevuta','reservations',v_reservation.id
    );
  else
    if v_deposit.status not in ('PENDING','FAILED') then
      raise exception 'DEPOSIT_CALLBACK_OUT_OF_ORDER';
    end if;

    if v_deposit.status='PENDING' then
      update public.reservation_deposits
      set status='FAILED'
      where id=v_deposit.id
      returning * into v_deposit;
    end if;
  end if;

  insert into private.reservation_deposit_provider_events(
    provider,event_id,deposit_id,provider_reference,event_state
  ) values(v_provider,p_event_id,v_deposit.id,v_ref,v_state);

  return jsonb_build_object(
    'deposit_id',v_deposit.id,
    'reservation_id',v_reservation.id,
    'deposit_status',v_deposit.status,
    'reservation_status',v_reservation.status,
    'duplicate_event',false
  );
end
$$;

revoke all on function public.begin_reservation_deposit(uuid,text,text,uuid)
from public,anon,authenticated;
revoke all on function public.bind_reservation_deposit_provider_reference(uuid,text,text)
from public,anon,authenticated;
revoke all on function public.apply_reservation_deposit_callback(text,text,text,text)
from public,anon,authenticated;

grant execute on function public.begin_reservation_deposit(uuid,text,text,uuid)
to service_role,postgres;
grant execute on function public.bind_reservation_deposit_provider_reference(uuid,text,text)
to service_role,postgres;
grant execute on function public.apply_reservation_deposit_callback(text,text,text,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.begin_reservation_deposit(uuid,text,text,uuid)','service_role'),
  ('public.bind_reservation_deposit_provider_reference(uuid,text,text)','service_role'),
  ('public.apply_reservation_deposit_callback(text,text,text,text)','service_role')
on conflict do nothing;