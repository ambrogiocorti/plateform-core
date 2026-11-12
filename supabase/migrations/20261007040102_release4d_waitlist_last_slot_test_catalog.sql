insert into private.release_test_catalog(key,category,required,description)
values(
  'WAITLIST_LAST_SLOT_ATOMICITY',
  'CHAOS',
  true,
  'Two accepted waitlist offers competing for the final capacity are serialized on the service lock; only one converts to a reservation.'
)
on conflict(key) do nothing;