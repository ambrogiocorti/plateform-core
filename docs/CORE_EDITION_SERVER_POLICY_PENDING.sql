-- NOT APPLIED. Development-first preflight proposal for the CORE edition.
-- The remote migration operation was blocked; this file is NOT part of the
-- migration-manifest and MUST NOT be regarded as database release evidence.
-- Abort without changing anything if existing provider transactions or
-- active unsupported hardware require an operator's reconciliation.
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
  IF EXISTS (SELECT 1 FROM public.print_devices
             WHERE active AND driver IN ('EPOS', 'BRIDGE')) THEN
    RAISE EXCEPTION 'CORE_EDITION_ACTIVE_EXTERNAL_PRINT_DEVICES';
  END IF;
END
$policy$;

-- These license flags already guard the authoritative payment RPC.
UPDATE public.feature_flags
SET licensed = false, version = version + 1, updated_at = clock_timestamp()
WHERE name IN ('STRIPE', 'SATISPAY_API') AND licensed = true;

-- Defense in depth: independent of browser state, register configuration,
-- or a future accidental flag change.
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
BEFORE INSERT ON public.payments
FOR EACH ROW EXECUTE FUNCTION private.core_edition_payment_guard();

CREATE OR REPLACE FUNCTION private.core_edition_print_driver_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $core$
BEGIN
  IF NEW.driver <> 'BROWSER' THEN
    RAISE EXCEPTION 'PRINT_DRIVER_NOT_INCLUDED';
  END IF;
  RETURN NEW;
END
$core$;
REVOKE ALL ON FUNCTION private.core_edition_print_driver_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER core_edition_print_drivers
BEFORE INSERT OR UPDATE OF driver ON public.print_devices
FOR EACH ROW EXECUTE FUNCTION private.core_edition_print_driver_guard();
