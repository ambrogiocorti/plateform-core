-- PGlite fixture ONLY; extracted hosted reservation_deposits table shape
-- exists in Supabase Development but is absent from tracked historical migrations.
-- Not a migration and not a clean-install declaration.
CREATE TABLE public.reservation_deposits(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reservation_id uuid NOT NULL REFERENCES public.reservations(id),
 venue_id uuid NOT NULL REFERENCES public.venues(id),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),
 currency text NOT NULL DEFAULT 'EUR' CHECK(currency='EUR'),
 provider text CHECK(provider IN('STRIPE','SATISPAY')),
 provider_reference text CHECK(provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 240),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','COMPLETED','FAILED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED')),
 expires_at timestamptz NOT NULL,
 completed_at timestamptz,
 refunded_amount_cents bigint NOT NULL DEFAULT 0 CHECK(refunded_amount_cents>=0),
 version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(refunded_amount_cents<=amount_cents),
 CHECK((status IN ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED'))=(completed_at IS NOT NULL)),
 CHECK(status<>'REFUNDED' OR refunded_amount_cents=amount_cents),
 CHECK(status<>'PARTIALLY_REFUNDED' OR (refunded_amount_cents>0 AND refunded_amount_cents<amount_cents))
);
ALTER TABLE public.reservation_deposits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reservation_deposits FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.reservation_deposits TO authenticated;
CREATE POLICY reservation_deposits_staff_read ON public.reservation_deposits
 FOR SELECT TO authenticated USING (
 private.installation_active() AND private.is_role(ARRAY['ADMIN','HOST']::public.user_role[])
 AND private.has_venue(venue_id)
);
