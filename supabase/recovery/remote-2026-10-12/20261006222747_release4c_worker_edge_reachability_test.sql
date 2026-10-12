
insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_MESSAGE_WORKER_EDGE_REACHABILITY',
  'REGRESSION',
  true,
  'Internal worker token reaches reservation-message-worker Edge Function and the worker can call the service-role-only claim RPC without exposing a public execution path.'
)
on conflict(key) do nothing;
