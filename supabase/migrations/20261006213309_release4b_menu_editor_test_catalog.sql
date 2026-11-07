
insert into private.release_test_catalog(key,category,required,description)
values(
  'MENU_EDITOR_IDEMPOTENCY_VERSIONING',
  'REGRESSION',
  true,
  'Menu editor is idempotent, versioned, keeps public QR identity stable and atomically rewrites venue/category/dish assignments.'
)
on conflict(key) do nothing;
