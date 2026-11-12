
insert into private.release_test_catalog(key,category,required,description)
values(
  'FORCE_CLOSE_PATH_ISOLATION',
  'SECURITY',
  true,
  'Exceptional account closure cannot bypass force-close controls: normal close requires settled balance, while force-close requires ADMIN and a resource-bound FORCE_CLOSE step-up grant.'
)
on conflict(key) do nothing;
