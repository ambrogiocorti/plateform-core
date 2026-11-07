insert into private.release_test_catalog(key,category,required,description) values
  ('RESERVATION_DEPOSIT_EXPIRY_CAPACITY','REGRESSION',true,'Expired pending deposits atomically expire their reservation, revoke access and release booking capacity.'),
  ('RESERVATION_DEPOSIT_EDGE_REACHABILITY','REGRESSION',true,'Public reservation-deposit Edge Function is deployed and returns controlled validation errors instead of runtime failures.')
on conflict(key) do nothing;