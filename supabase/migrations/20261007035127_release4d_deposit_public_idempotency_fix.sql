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
  v_existing private.public_requests;
  v_payload jsonb;
  v_digest text;
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

  v_payload:=jsonb_build_object(
    'deposit',p_deposit,
    'token_hash',private.deposit_access_token_hash(p_access_token),
    'provider',v_provider
  );
  v_digest:=encode(extensions.digest(v_payload::text,'sha256'),'hex');

  perform pg_advisory_xact_lock(
    hashtextextended('reservation_deposit_start:'||p_key::text,0)
  );

  select * into v_existing
  from private.public_requests
  where operation='reservation_deposit_start'
    and idempotency_key=p_key;

  if found then
    if v_existing.payload_hash<>v_digest then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode='22023';
    end if;
    return v_existing.response;
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

  insert into private.public_requests(
    operation,idempotency_key,payload_hash,response
  ) values(
    'reservation_deposit_start',p_key,v_digest,v_result
  );

  return v_result;
end
$$;