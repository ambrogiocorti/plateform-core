-- PGlite-only hosted feature flag constraint restoration. The authoritative
-- Development constraint includes BOOKING_DEPOSITS but historical local SQL
-- does not. No production constraint is changed by this test fixture.
ALTER TABLE public.feature_flags DROP CONSTRAINT IF EXISTS feature_flags_name_check;
ALTER TABLE public.feature_flags ADD CONSTRAINT feature_flags_name_check CHECK ((name = ANY (ARRAY['MULTI_VENUE'::text, 'CLIENT_ORDERING'::text, 'STRIPE'::text, 'SATISPAY_API'::text, 'OFFLINE'::text, 'ADVANCED_ROOM_EDITOR'::text, 'ADVANCED_ANALYTICS'::text, 'RESERVATION_MESSAGING'::text, 'WHATSAPP_TELEGRAM_SMS_MESSAGING'::text, 'BOOKING_DEPOSITS'::text, 'WAITLIST'::text, 'TAKEAWAY'::text, 'FOOD_COST'::text, 'MENU_PROMOTIONS'::text, 'MULTI_MENU_QR'::text])));
