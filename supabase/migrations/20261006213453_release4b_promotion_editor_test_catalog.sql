
insert into private.release_test_catalog(key,category,required,description)
values(
  'PROMOTION_EDITOR_IDEMPOTENCY_VERSIONING',
  'REGRESSION',
  true,
  'Promotion editor is idempotent and versioned; expiry removes the promotion from public payload without altering authoritative dish price.'
)
on conflict(key) do nothing;
