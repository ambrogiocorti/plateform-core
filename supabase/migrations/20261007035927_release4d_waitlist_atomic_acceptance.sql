create or replace function private.verify_waitlist_offer_access(
  p_entry uuid,
  p_token text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1
    from private.waitlist_offer_access a
    join public.waitlist_entries w on w.id=a.entry_id
    where a.entry_id=p_entry
      and a.revoked_at is null
      and a.expires_at>clock_timestamp()
      and w.status='OFFERED'
      and w.offer_expires_at>clock_timestamp()
      and a.token_hash=private.waitlist_token_hash(p_token)
  )
$$;

revoke all on function private.verify_waitlist_offer_access(uuid,text)
from public,anon,authenticated;

create or replace function public.accept_waitlist_offer(
  p_entry uuid,
  p_access_token text,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_entry public.waitlist_entries;
  v_access private.waitlist_offer_access;
  v_service public.services;
  v_capacity jsonb;
  v_available_covers integer;
  v_available_arrivals integer;
  v_existing private.public_requests;
  v_digest text;
  v_result jsonb;
  v_reservation_id uuid;
  v_booking_status public.reservation_status:='RESERVED';
  v_deposit_decision jsonb;
  v_deposit_amount bigint;
  v_deposit_expiry_minutes integer;
  v_deposit_id uuid;
  v_deposit_token text;
  v_deposit_expires_at timestamptz;
begin
  if p_entry is null
     or p_access_token is null
     or length(p_access_token) not between 32 and 256
     or p_key is null then
    raise exception 'INVALID_WAITLIST_ACCEPTANCE';
  end if;

  if not private.verify_waitlist_offer_access(p_entry,p_access_token) then
    raise exception 'WAITLIST_ACCESS_DENIED' using errcode='42501';
  end if;

  v_digest:=encode(extensions.digest(
    jsonb_build_object(
      'entry',p_entry,
      'token_hash',private.waitlist_token_hash(p_access_token)
    )::text,
    'sha256'
  ),'hex');

  perform pg_advisory_xact_lock(hashtextextended('waitlist_accept:'||p_key::text,0));

  select * into v_existing
  from private.public_requests
  where operation='waitlist_accept' and idempotency_key=p_key;

  if found then
    if v_existing.payload_hash<>v_digest then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode='22023';
    end if;
    return v_existing.response;
  end if;

  select * into v_entry
  from public.waitlist_entries
  where id=p_entry
  for update;

  if v_entry.id is null then raise exception 'NOT_FOUND'; end if;
  if v_entry.status<>'OFFERED' then raise exception 'WAITLIST_NOT_OFFERED'; end if;
  if v_entry.offer_expires_at<=clock_timestamp() then raise exception 'WAITLIST_OFFER_EXPIRED'; end if;
  if not private.venue_feature_enabled(v_entry.venue_id,'WAITLIST') then
    raise exception 'WAITLIST_DISABLED';
  end if;

  select * into v_access
  from private.waitlist_offer_access
  where entry_id=v_entry.id
  for update;

  if v_access.entry_id is null
     or v_access.revoked_at is not null
     or v_access.expires_at<=clock_timestamp()
     or v_access.token_hash<>private.waitlist_token_hash(p_access_token) then
    raise exception 'WAITLIST_ACCESS_DENIED' using errcode='42501';
  end if;

  select * into v_service
  from public.services
  where id=v_entry.service_id and venue_id=v_entry.venue_id and active
  for update;

  if v_service.id is null then raise exception 'SERVICE_UNAVAILABLE'; end if;

  v_capacity:=private.booking_capacity_snapshot(
    v_entry.service_id,v_entry.service_date,v_access.offered_time
  );
  v_available_covers:=coalesce((v_capacity->>'available_covers')::integer,0);
  v_available_arrivals:=coalesce((v_capacity->>'available_arrivals')::integer,0);

  if not coalesce((v_capacity->>'available')::boolean,false)
     or v_entry.party_size>v_available_covers
     or v_available_arrivals<1 then
    raise exception 'WAITLIST_CAPACITY_LOST' using errcode='40001';
  end if;

  v_deposit_decision:=private.reservation_deposit_amount(
    v_entry.service_id,v_entry.service_date,v_access.offered_time,v_entry.party_size
  );

  if coalesce((v_deposit_decision->>'requires_deposit')::boolean,false) then
    if not private.venue_feature_enabled(v_entry.venue_id,'BOOKING_DEPOSITS') then
      raise exception 'BOOKING_DEPOSITS_DISABLED';
    end if;

    v_deposit_amount:=(v_deposit_decision->>'calculated_amount_cents')::bigint;
    v_deposit_expiry_minutes:=(v_deposit_decision->>'expiry_minutes')::integer;

    if v_deposit_amount is null or v_deposit_amount<=0 or v_deposit_expiry_minutes is null then
      raise exception 'INVALID_DEPOSIT_POLICY';
    end if;

    v_booking_status:='PENDING_DEPOSIT';
  end if;

  insert into public.reservations(
    venue_id,service_id,service_date,slot_time,
    first_name,last_name,phone,party_size,status,walk_in,host_note
  ) values(
    v_entry.venue_id,v_entry.service_id,v_entry.service_date,v_access.offered_time,
    v_entry.customer_name,'',v_entry.customer_phone,v_entry.party_size,v_booking_status,false,
    nullif(trim(v_entry.notes),'')
  )
  returning id into v_reservation_id;

  update public.waitlist_entries
  set status='CONFIRMED',
      confirmed_at=clock_timestamp()
  where id=v_entry.id;

  update public.waitlist_entries
  set status='CONVERTED_TO_RESERVATION',
      converted_reservation_id=v_reservation_id
  where id=v_entry.id;

  update private.waitlist_offer_access
  set revoked_at=clock_timestamp()
  where entry_id=v_entry.id;

  if v_booking_status='PENDING_DEPOSIT' then
    v_deposit_expires_at:=clock_timestamp()+make_interval(mins=>v_deposit_expiry_minutes);
    v_deposit_token:=encode(extensions.gen_random_bytes(32),'hex');

    insert into public.reservation_deposits(
      reservation_id,venue_id,amount_cents,currency,status,expires_at
    ) values(
      v_reservation_id,v_entry.venue_id,v_deposit_amount,'EUR','PENDING',v_deposit_expires_at
    )
    returning id into v_deposit_id;

    insert into private.reservation_deposit_access(deposit_id,token_hash,expires_at)
    values(
      v_deposit_id,
      private.deposit_access_token_hash(v_deposit_token),
      v_deposit_expires_at
    );
  end if;

  insert into public.notifications(
    venue_id,recipient_role,category,title,resource_type,resource_id
  ) values(
    v_entry.venue_id,'HOST','RESERVATION',
    case when v_booking_status='PENDING_DEPOSIT'
      then 'Waitlist accettata · caparra richiesta'
      else 'Waitlist convertita in prenotazione'
    end,
    'reservations',v_reservation_id
  );

  v_result:=jsonb_build_object(
    'entry_id',v_entry.id,
    'status','CONVERTED_TO_RESERVATION',
    'reservation_id',v_reservation_id,
    'reservation_status',v_booking_status,
    'offered_time',v_access.offered_time,
    'deposit',case
      when v_deposit_id is null then null
      else jsonb_build_object(
        'id',v_deposit_id,
        'amount_cents',v_deposit_amount,
        'currency','EUR',
        'expires_at',v_deposit_expires_at,
        'access_token',v_deposit_token
      )
    end
  );

  insert into private.public_requests(operation,idempotency_key,payload_hash,response)
  values('waitlist_accept',p_key,v_digest,v_result);

  return v_result;
end
$$;

revoke all on function public.accept_waitlist_offer(uuid,text,uuid)
from public,anon,authenticated;
grant execute on function public.accept_waitlist_offer(uuid,text,uuid)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.accept_waitlist_offer(uuid,text,uuid)','service_role')
on conflict do nothing;