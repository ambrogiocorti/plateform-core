-- Plateform CORE live test: real public reservation RPCs, without and with the large-group
-- booking deposit (owner decision 2026-10-21, migration 20261021090000).
-- Execute only on an isolated Development/staging fixture. All mutations roll back.
-- No provider is called: the verified provider result is simulated with the same service_role
-- RPCs the stripe-webhook / reservation-deposit read path uses.
BEGIN;
-- Start from "deposits not licensed" whatever the fixture says (rolled back at the end).
UPDATE public.feature_flags SET licensed=false WHERE name='BOOKING_DEPOSITS' AND licensed;
UPDATE public.restaurant_profile
SET public_content=pg_catalog.jsonb_set(coalesce(public_content,'{}'::jsonb),
  '{privacy_url}','"https://plateform-test.example/privacy"'::jsonb,true);
UPDATE public.venue_settings SET reservations_enabled=true
WHERE venue_id='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
INSERT INTO public.service_booking_rules (
  venue_id,service_id,max_covers_service,slot_interval_minutes,
  max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm,
  large_party_mode,deposit_policy
) VALUES (
  '8241033e-7053-44d3-9427-fbf7ea72e684',
  'c6d755c7-647e-430c-8685-cc0c8cba8fdd',
  100,30,10,20,2,'REQUESTED','DISABLED'
)
ON CONFLICT(service_id) DO UPDATE SET
  max_covers_service=100,slot_interval_minutes=30,
  max_arrivals_per_slot=10,max_covers_per_slot=20,
  max_party_size_auto_confirm=2,large_party_mode='REQUESTED',
  deposit_policy='DISABLED',deposit_amount_cents=NULL,
  deposit_percentage_bps=NULL,deposit_expiry_minutes=NULL;
DO $core_booking_test$
DECLARE
  v_venue CONSTANT uuid := '8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_service CONSTANT uuid := 'c6d755c7-647e-430c-8685-cc0c8cba8fdd'::uuid;
  v_date date;
  v_availability jsonb;
  v_confirmed jsonb;
  v_replayed jsonb;
  v_requested jsonb;
  v_key uuid := gen_random_uuid();
  v_rate_key text := repeat(replace(gen_random_uuid()::text,'-',''),2);
  v_licensing_error text;
BEGIN
  v_date := (now() at time zone
    (SELECT timezone FROM public.venues WHERE id=v_venue))::date + 2;
  IF (SELECT licensed FROM public.feature_flags WHERE name='BOOKING_DEPOSITS')
    IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'CORE_DEPOSITS_MUST_BE_UNLICENSED';
  END IF;
  v_availability:=public.get_public_booking_availability(v_venue,v_service,v_date,2);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_availability->'slots') s
    WHERE s->>'time'='21:00' AND (s->>'available')::boolean
      AND s->>'status_if_booked'='RESERVED' AND s->'deposit' IS NULL
  ) THEN RAISE EXCEPTION 'CORE_AVAILABILITY_WITHOUT_DEPOSIT_FAILED'; END IF;

  v_confirmed:=public.create_public_reservation(
    v_venue,v_service,v_date,time '21:00',
    'CORE','Regression','+390000008841',2,'{}'::jsonb,v_key,v_rate_key);
  IF v_confirmed->>'status'<>'RESERVED'
    OR v_confirmed->>'id' IS NULL
    OR v_confirmed ? 'deposit'
  THEN RAISE EXCEPTION 'CORE_CONFIRMED_BOOKING_FAILED'; END IF;

  v_replayed:=public.create_public_reservation(
    v_venue,v_service,v_date,time '21:00',
    'CORE','Regression','+390000008841',2,'{}'::jsonb,v_key,v_rate_key);
  IF v_replayed<>v_confirmed THEN
    RAISE EXCEPTION 'CORE_BOOKING_IDEMPOTENCY_FAILED';
  END IF;

  v_requested:=public.create_public_reservation(
    v_venue,v_service,v_date,time '21:30',
    'CORE','Large','+390000008842',3,'{}'::jsonb,
    gen_random_uuid(),v_rate_key);
  IF v_requested->>'status'<>'REQUESTED' OR v_requested ? 'deposit' THEN
    RAISE EXCEPTION 'CORE_LARGE_GROUP_REQUEST_FAILED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.reservation_deposits
    WHERE reservation_id IN (
      (v_confirmed->>'id')::uuid,(v_requested->>'id')::uuid
    )
  ) THEN RAISE EXCEPTION 'CORE_ONLINE_DEPOSIT_CREATED'; END IF;

  -- Deposits may be licensed only together with a provider licence.
  IF NOT (private.feature_licensed('STRIPE') OR private.feature_licensed('SATISPAY_API')) THEN
    BEGIN
      UPDATE public.feature_flags SET licensed=true WHERE name='BOOKING_DEPOSITS';
      RAISE EXCEPTION 'CORE_DEPOSIT_LICENSE_BYPASS';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_licensing_error=MESSAGE_TEXT;
      IF v_licensing_error <> 'BOOKING_DEPOSITS_PROVIDER_LICENCE_REQUIRED' THEN RAISE; END IF;
    END;
  ELSE
    RAISE NOTICE 'provider already licensed on this fixture: licence-without-provider case skipped';
  END IF;
END
$core_booking_test$;
-- Negative CORE scenario: a legacy deposit-required rule must fail closed.
UPDATE public.service_booking_rules
SET deposit_policy='REQUIRED',deposit_amount_cents=1000,
    deposit_percentage_bps=NULL,deposit_expiry_minutes=30
WHERE service_id='c6d755c7-647e-430c-8685-cc0c8cba8fdd'::uuid;
DO $core_deposit_test$
DECLARE
  v_venue CONSTANT uuid := '8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_service CONSTANT uuid := 'c6d755c7-647e-430c-8685-cc0c8cba8fdd'::uuid;
  v_date date;
  v_slots jsonb;
  v_error text;
BEGIN
  v_date:=(now() at time zone
    (SELECT timezone FROM public.venues WHERE id=v_venue))::date+2;
  v_slots:=public.get_public_booking_availability(v_venue,v_service,v_date,2);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_slots->'slots') s
    WHERE s->>'time'='21:00' AND NOT (s->>'available')::boolean
      AND s->>'reason'='BOOKING_DEPOSITS_DISABLED'
  ) THEN RAISE EXCEPTION 'CORE_FAIL_CLOSED_AVAILABILITY_BYPASS'; END IF;
  BEGIN
    PERFORM public.create_public_reservation(
      v_venue,v_service,v_date,time '21:00',
      'CORE','No-deposit','+390000008844',2,'{}'::jsonb,
      gen_random_uuid(),repeat(replace(gen_random_uuid()::text,'-',''),2));
    RAISE EXCEPTION 'CORE_FAIL_CLOSED_CREATE_BYPASS';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT;
    IF v_error<>'BOOKING_DEPOSITS_DISABLED' THEN RAISE; END IF;
  END;
END $core_deposit_test$;
-- Licensed scenario: a large group pays the guarantee, small groups are unchanged.
UPDATE public.feature_flags SET licensed=true WHERE name='STRIPE' AND NOT licensed;
UPDATE public.feature_flags SET licensed=true WHERE name='BOOKING_DEPOSITS';
UPDATE public.venue_settings
SET payment_methods=array_append(payment_methods,'STRIPE'::public.payment_method)
WHERE venue_id='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid
  AND NOT ('STRIPE'::public.payment_method=any(payment_methods));
INSERT INTO public.venue_features(venue_id,name,enabled)
VALUES('8241033e-7053-44d3-9427-fbf7ea72e684','BOOKING_DEPOSITS',true)
ON CONFLICT(venue_id,name) DO UPDATE SET enabled=true;
UPDATE public.service_booking_rules
SET max_party_size_auto_confirm=8,deposit_policy='CONDITIONAL',deposit_condition_mode='ALL',
    deposit_min_party_size=6,deposit_amount_cents=2000,deposit_percentage_bps=NULL,
    deposit_expiry_minutes=45,deposit_weekdays='{}',deposit_dates='{}',
    deposit_start_time=NULL,deposit_end_time=NULL,deposit_no_show_action='RETAIN',
    deposit_no_show_refund_bps=NULL,deposit_cancel_refund_hours=24
WHERE service_id='c6d755c7-647e-430c-8685-cc0c8cba8fdd'::uuid;
DO $large_group_deposit_test$
DECLARE
  v_venue CONSTANT uuid := '8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_service CONSTANT uuid := 'c6d755c7-647e-430c-8685-cc0c8cba8fdd'::uuid;
  v_date date;
  v_slots jsonb;
  v_small jsonb;
  v_large jsonb;
  v_absent jsonb;
  v_result jsonb;
  v_ref text;
BEGIN
  v_date:=(now() at time zone
    (SELECT timezone FROM public.venues WHERE id=v_venue))::date+2;
  v_slots:=public.get_public_booking_availability(v_venue,v_service,v_date,6);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_slots->'slots') s
    WHERE s->>'time'='21:00' AND (s->>'available')::boolean
      AND s->>'status_if_booked'='PENDING_DEPOSIT'
      AND (s->'deposit'->>'amount_cents')::bigint=2000
      AND s->'deposit'->'providers' ? 'STRIPE'
  ) THEN RAISE EXCEPTION 'LARGE_GROUP_DEPOSIT_AVAILABILITY_FAILED'; END IF;

  v_small:=public.create_public_reservation(
    v_venue,v_service,v_date,time '21:00',
    'CORE','Small','+390000008851',2,'{}'::jsonb,
    gen_random_uuid(),repeat(replace(gen_random_uuid()::text,'-',''),2));
  IF v_small->>'status'<>'RESERVED' OR v_small ? 'deposit' THEN
    RAISE EXCEPTION 'SMALL_GROUP_CHANGED';
  END IF;

  v_large:=public.create_public_reservation(
    v_venue,v_service,v_date,time '21:00',
    'CORE','Large','+390000008852',6,'{}'::jsonb,
    gen_random_uuid(),repeat(replace(gen_random_uuid()::text,'-',''),2));
  IF v_large->>'status'<>'PENDING_DEPOSIT'
     OR (v_large->'deposit'->>'amount_cents')::bigint<>2000 THEN
    RAISE EXCEPTION 'LARGE_GROUP_PENDING_DEPOSIT_FAILED';
  END IF;

  -- Verified provider result, exactly as stripe-webhook / reservation-deposit apply it.
  v_ref:='cs_test_live_'||left(replace(gen_random_uuid()::text,'-',''),16);
  PERFORM public.begin_reservation_deposit(
    (v_large->'deposit'->>'id')::uuid,v_large->'deposit'->>'access_token','STRIPE',gen_random_uuid());
  PERFORM public.bind_reservation_deposit_provider_reference(
    (v_large->'deposit'->>'id')::uuid,'STRIPE',v_ref);
  v_result:=public.apply_reservation_deposit_callback('STRIPE','read:'||v_ref||':COMPLETED',v_ref,'COMPLETED');
  IF v_result->>'reservation_status'<>'RESERVED' OR v_result->>'deposit_status'<>'COMPLETED' THEN
    RAISE EXCEPTION 'LARGE_GROUP_DEPOSIT_CONFIRMATION_FAILED';
  END IF;

  -- Honoured: full refund queued for the verified refund worker.
  UPDATE public.reservations SET status='ARRIVED' WHERE id=(v_large->>'id')::uuid;
  UPDATE public.reservations SET status='SEATED' WHERE id=(v_large->>'id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM private.reservation_deposit_no_show_actions
    WHERE reservation_id=(v_large->>'id')::uuid AND reason='HONOURED'
      AND policy='REFUND_FULL' AND state='QUEUED' AND requested_refund_cents=2000
  ) THEN RAISE EXCEPTION 'HONOURED_DEPOSIT_NOT_REFUNDED'; END IF;

  -- No-show: the guarantee is retained, no refund is queued.
  v_absent:=public.create_public_reservation(
    v_venue,v_service,v_date,time '21:30',
    'CORE','Absent','+390000008853',7,'{}'::jsonb,
    gen_random_uuid(),repeat(replace(gen_random_uuid()::text,'-',''),2));
  v_ref:='cs_test_live_'||left(replace(gen_random_uuid()::text,'-',''),16);
  PERFORM public.begin_reservation_deposit(
    (v_absent->'deposit'->>'id')::uuid,v_absent->'deposit'->>'access_token','STRIPE',gen_random_uuid());
  PERFORM public.bind_reservation_deposit_provider_reference(
    (v_absent->'deposit'->>'id')::uuid,'STRIPE',v_ref);
  PERFORM public.apply_reservation_deposit_callback('STRIPE','read:'||v_ref||':COMPLETED',v_ref,'COMPLETED');
  UPDATE public.reservations SET status='NO_SHOW' WHERE id=(v_absent->>'id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM private.reservation_deposit_no_show_actions
    WHERE reservation_id=(v_absent->>'id')::uuid AND reason='NO_SHOW' AND state='RETAINED'
  ) OR EXISTS (
    SELECT 1 FROM private.reservation_deposit_no_show_actions
    WHERE reservation_id=(v_absent->>'id')::uuid AND state='QUEUED'
  ) THEN RAISE EXCEPTION 'NO_SHOW_DEPOSIT_NOT_RETAINED'; END IF;
END $large_group_deposit_test$;
SELECT 'PASS' AS core_booking_transactional_test,
  'no persisted test records (ROLLBACK follows)' AS persistence;
ROLLBACK;
