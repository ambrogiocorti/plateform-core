
insert into private.release_test_catalog(key,category,required,description)
values(
  'PUBLIC_RESERVATION_EDGE_DEPOSIT_CONTRACT',
  'REGRESSION',
  true,
  'Public reservation Edge accepts RESERVED, REQUESTED and PENDING_DEPOSIT responses; reservation-deposit returns to /prenota; both public Edge endpoints are reachable and reject invalid payloads with application-level 400 responses.'
)
on conflict(key) do nothing;
