insert into private.release_test_catalog(key,category,required,description) values
  ('WAITLIST_PUBLIC_ENTRY_IDEMPOTENCY','REGRESSION',true,'Public waitlist entry is feature-gated, rate-limited and idempotent without creating a reservation.'),
  ('WAITLIST_OFFER_EXPIRY','REGRESSION',true,'Expired waitlist offers transition to EXPIRED, revoke the offer token and are processed by scheduled expiry runner.')
on conflict(key) do nothing;