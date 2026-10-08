-- NOT APPLIED. Development-first SQL proposal; it MUST be tested on a disposable
-- PostgreSQL staging instance before becoming a versioned migration.
-- This switches an installation to the CORE edition; do not apply on Production
-- or an installation with unsettled provider payments or printers in service.
-- SECURITY DEFINER routines and direct RPC calls must not be able to bypass
-- these table-level guards. Existing historical rows remain readable.

-- Preflight is deliberately fail-closed. Resolve provider operations, historical
-- payment reconciliation and unsupported active printers before rollout.
DO $policy$
BEGIN
  IF EXISTS (SELECT 1 FROM public.provider_operations
             WHERE state IN ('NEW', 'IN_FLIGHT', 'WAITING')) THEN
    RAISE EXCEPTION 'CORE_EDITION_PENDING_PROVIDER_OPERATIONS';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
             WHERE method IN ('STRIPE', 'SATISPAY_API', 'SATISPAY_POS')
               AND status NOT IN ('FAILED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'CORE_EDITION_EXISTING_PROVIDER_PAYMENTS';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservation_deposits
             WHERE status = 'PENDING') THEN
    RAISE EXCEPTION 'CORE_EDITION_PENDING_RESERVATION_DEPOSITS';
  END IF;
  IF EXISTS (SELECT 1 FROM public.refunds
             WHERE method IN ('STRIPE', 'SATISPAY_API', 'SATISPAY_POS')
               AND status NOT IN ('FAILED', 'REJECTED')) THEN
    RAISE EXCEPTION 'CORE_EDITION_EXISTING_PROVIDER_REFUNDS';
  END IF;
  IF EXISTS (SELECT 1 FROM public.print_devices
             WHERE active AND driver IN ('EPOS', 'BRIDGE')) THEN
    RAISE EXCEPTION 'CORE_EDITION_ACTIVE_EXTERNAL_PRINT_DEVICES';
  END IF;
  IF EXISTS (SELECT 1 FROM public.print_jobs j
             JOIN public.print_devices d ON d.id=j.print_device_id
             WHERE d.driver IN ('EPOS','BRIDGE')
               AND j.status IN ('QUEUED','SENT')) THEN
    RAISE EXCEPTION 'CORE_EDITION_PENDING_EXTERNAL_PRINT_JOBS';
  END IF;
END
$policy$;

-- Existing licensing is not sufficient on its own; other configuration RPCs
-- could otherwise re-enable an excluded method for a cash register or venue.
UPDATE public.feature_flags
SET licensed = false, version = version + 1, updated_at = clock_timestamp()
WHERE name IN ('STRIPE', 'SATISPAY_API', 'BOOKING_DEPOSITS') AND licensed = true;

CREATE OR REPLACE FUNCTION private.core_edition_license_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $core$
BEGIN
  IF NEW.name IN ('STRIPE', 'SATISPAY_API', 'BOOKING_DEPOSITS') AND NEW.licensed THEN
    RAISE EXCEPTION 'CORE_PROVIDER_LICENSE_FORBIDDEN';
  END IF;
  RETURN NEW;
END
$core$;
REVOKE ALL ON FUNCTION private.core_edition_license_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER core_edition_license
BEFORE INSERT OR UPDATE OF licensed ON public.feature_flags
FOR EACH ROW EXECUTE FUNCTION private.core_edition_license_guard();

-- Authoritative controls apply even if a privileged RPC ignores edition flags.
CREATE OR REPLACE FUNCTION private.core_edition_payment_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $core$
BEGIN
  IF NEW.method NOT IN ('CASH', 'CARD_POS') THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_UNLICENSED';
  END IF;
  RETURN NEW;
END
$core$;
REVOKE ALL ON FUNCTION private.core_edition_payment_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER core_edition_payment_methods
BEFORE INSERT OR UPDATE OF method ON public.payments
FOR EACH ROW EXECUTE FUNCTION private.core_edition_payment_guard();
CREATE TRIGGER core_edition_refund_methods
BEFORE INSERT OR UPDATE OF method ON public.refunds
FOR EACH ROW EXECUTE FUNCTION private.core_edition_payment_guard();

CREATE OR REPLACE FUNCTION private.core_edition_register_methods_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $core$
BEGIN
  IF NEW.payment_methods IS NULL OR
     EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW.payment_methods) AS m(method)
             WHERE m.method IS NULL OR m.method NOT IN ('CASH','CARD_POS')) THEN
    RAISE EXCEPTION 'CORE_REGISTER_PAYMENT_METHODS_FORBIDDEN';
  END IF;
  RETURN NEW;
END
$core$;
REVOKE ALL ON FUNCTION private.core_edition_register_methods_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER core_edition_venue_payment_methods
BEFORE INSERT OR UPDATE OF payment_methods ON public.venue_settings
FOR EACH ROW EXECUTE FUNCTION private.core_edition_register_methods_guard();
CREATE TRIGGER core_edition_cash_register_payment_methods
BEFORE INSERT OR UPDATE OF payment_methods ON public.cash_registers
FOR EACH ROW EXECUTE FUNCTION private.core_edition_register_methods_guard();

-- Historical provider operations can be read/reconciled, but no new command
-- may be created in CORE (including from a privileged SECURITY DEFINER RPC).
CREATE OR REPLACE FUNCTION private.core_edition_new_provider_operation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $core$
BEGIN
  RAISE EXCEPTION 'CORE_PROVIDER_OPERATION_FORBIDDEN';
END
$core$;
REVOKE ALL ON FUNCTION private.core_edition_new_provider_operation_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER core_edition_new_provider_operation
BEFORE INSERT ON public.provider_operations
FOR EACH ROW EXECUTE FUNCTION private.core_edition_new_provider_operation_guard();

CREATE OR REPLACE FUNCTION private.core_edition_print_driver_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $core$
BEGIN
  -- Permit *deactivation* of a pre-existing unsupported printer, never
  -- creation, reactivation or driver switching to an unsupported device.
  IF TG_OP = 'INSERT' THEN
    IF NEW.driver <> 'BROWSER' THEN
      RAISE EXCEPTION 'PRINT_DRIVER_NOT_INCLUDED';
    END IF;
  ELSIF NEW.driver <> 'BROWSER' AND
        (NEW.active OR NEW.driver IS DISTINCT FROM OLD.driver) THEN
    RAISE EXCEPTION 'PRINT_DRIVER_NOT_INCLUDED';
  END IF;
  RETURN NEW;
END
$core$;
REVOKE ALL ON FUNCTION private.core_edition_print_driver_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER core_edition_print_drivers
BEFORE INSERT OR UPDATE OF driver,active ON public.print_devices
FOR EACH ROW EXECUTE FUNCTION private.core_edition_print_driver_guard();

-- A queued print job is also guarded in case an existing unsupported printer
-- is addressed directly via the request RPC rather than through the browser.
CREATE OR REPLACE FUNCTION private.core_edition_print_job_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $core$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.print_devices d
    WHERE d.id = NEW.print_device_id AND d.venue_id = NEW.venue_id
      AND d.driver = 'BROWSER' AND d.active
  ) THEN
    RAISE EXCEPTION 'CORE_PRINT_DEVICE_FORBIDDEN';
  END IF;
  RETURN NEW;
END
$core$;
REVOKE ALL ON FUNCTION private.core_edition_print_job_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER core_edition_print_jobs
BEFORE INSERT OR UPDATE OF print_device_id ON public.print_jobs
FOR EACH ROW EXECUTE FUNCTION private.core_edition_print_job_guard();
