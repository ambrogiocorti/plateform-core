insert into private.release_test_catalog(key,category,required,description) values
  ('RESERVATION_DEPOSIT_POLICY_FLOW','REGRESSION',true,'Booking deposit policy is evaluated server-side; required fixed deposits enter PENDING_DEPOSIT with opaque access token, feature-gate fail closed and large-group precedence.'),
  ('RESERVATION_DEPOSIT_STATE_MACHINE','REGRESSION',true,'Reservation deposit lifecycle enforces valid transitions, immutability and audit.')
on conflict(key) do nothing;