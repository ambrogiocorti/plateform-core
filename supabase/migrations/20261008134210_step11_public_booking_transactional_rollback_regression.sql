
create or replace function private.test_step11_public_booking_transaction()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $test$
declare
  v_venue uuid := '8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_service uuid := 'c6d755c7-647e-430c-8685-cc0c8cba8fdd'::uuid;
  v_date date;
  v_key uuid := pg_catalog.gen_random_uuid();
  v_retry uuid := pg_catalog.gen_random_uuid();
  v_deposit_key uuid := pg_catalog.gen_random_uuid();
  v_rate text := pg_catalog.repeat('e',64);
  v_reserved jsonb;
  v_replay jsonb;
  v_requested jsonb;
  v_pending jsonb;
  v_evidence jsonb;
  v_detail text;
begin
  v_date := (pg_catalog.now() at time zone
    (select timezone from public.venues where id=v_venue))::date + 2;
  begin
    update public.restaurant_profile
    set public_content=pg_catalog.jsonb_set(pg_catalog.coalesce(public_content,'{}'::jsonb),
       '{privacy_url}','"https://plateform-test.example/privacy"'::jsonb,true)
    where id;
    update public.venue_settings set reservations_enabled=true where venue_id=v_venue;

    insert into public.service_booking_rules(
      venue_id,service_id,max_covers_service,slot_interval_minutes,
      max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm,
      large_party_mode,deposit_policy
    ) values(v_venue,v_service,100,30,10,20,2,'REQUESTED','DISABLED')
    on conflict(service_id) do update set
      max_covers_service=100,slot_interval_minutes=30,
      max_arrivals_per_slot=10,max_covers_per_slot=20,
      max_party_size_auto_confirm=2,large_party_mode='REQUESTED',
      deposit_policy='DISABLED',deposit_amount_cents=null,
      deposit_percentage_bps=null,deposit_expiry_minutes=null;

    v_reserved := public.create_public_reservation(
      v_venue,v_service,v_date,'21:00'::time,'QA','Reservation',
      '+390000008801',2,'{}'::jsonb,v_key,v_rate);
    if v_reserved->>'status'<>'RESERVED' or v_reserved->>'id' is null
    then raise exception 'STEP11_RESERVED_WRITE_FAILED'; end if;

    v_replay := public.create_public_reservation(
      v_venue,v_service,v_date,'21:00'::time,'QA','Reservation',
      '+390000008801',2,'{}'::jsonb,v_key,v_rate);
    if v_replay<>v_reserved then raise exception 'STEP11_IDEMPOTENT_REPLAY_FAILED'; end if;

    v_requested := public.create_public_reservation(
      v_venue,v_service,v_date,'21:30'::time,'QA','Group',
      '+390000008802',3,'{}'::jsonb,v_retry,v_rate);
    if v_requested->>'status'<>'REQUESTED' then
      raise exception 'STEP11_LARGE_PARTY_REQUEST_FAILED';
    end if;

    update public.feature_flags set licensed=true where name='BOOKING_DEPOSITS';
    insert into public.venue_features(venue_id,name,enabled)
      values(v_venue,'BOOKING_DEPOSITS',true)
      on conflict(venue_id,name) do update set enabled=true;
    update public.service_booking_rules
    set deposit_policy='REQUIRED',deposit_amount_cents=1000,
      deposit_percentage_bps=null,deposit_expiry_minutes=30
    where service_id=v_service;

    v_pending := public.create_public_reservation(
      v_venue,v_service,v_date+1,'21:00'::time,'QA','Deposit',
      '+390000008803',2,'{}'::jsonb,v_deposit_key,v_rate);
    if v_pending->>'status'<>'PENDING_DEPOSIT' or
       (v_pending->'deposit'->>'amount_cents')::bigint<>1000 or
       pg_catalog.length(v_pending->'deposit'->>'access_token')<32
    then raise exception 'STEP11_DEPOSIT_WRITE_FAILED'; end if;

    if not exists(select 1 from public.reservation_deposits d
       where d.id=(v_pending->'deposit'->>'id')::uuid
         and d.status='PENDING' and d.amount_cents=1000
         and d.reservation_id=(v_pending->>'id')::uuid)
    then raise exception 'STEP11_DEPOSIT_ROW_NOT_FOUND'; end if;

    v_evidence := pg_catalog.jsonb_build_object(
      'reserved',true,'requested',true,'pending_deposit',true,
      'idempotent_replay',true,'deposit_row_verified',true,
      'test_rows_persisted',false);
    raise exception '__ROLLBACK_STEP11_RESERVATION_WRITE_TEST__'
       using detail=v_evidence::text;
  exception when others then
    get stacked diagnostics v_detail=pg_exception_detail;
    if sqlerrm='__ROLLBACK_STEP11_RESERVATION_WRITE_TEST__'
    then return v_detail::jsonb; end if;
    raise;
  end;
end
$test$;
revoke all on function private.test_step11_public_booking_transaction() from public,anon,authenticated;
grant execute on function private.test_step11_public_booking_transaction() to service_role;