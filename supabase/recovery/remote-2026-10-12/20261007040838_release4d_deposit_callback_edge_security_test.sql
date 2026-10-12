
insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_DEPOSIT_CALLBACK_EDGE_SECURITY',
  'SECURITY',
  true,
  'Reservation deposit provider callbacks verify provider authenticity and server-side payment facts before applying authoritative deposit state.'
)
on conflict(key) do nothing;
