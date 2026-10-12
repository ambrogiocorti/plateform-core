
insert into private.release_test_catalog(key,category,required,description)
values(
  'CHAIN_ADMIN_PRIVACY_CONFIG_REACHABILITY',
  'REGRESSION',
  true,
  'Chain-level privacy/retention configuration is reachable by an authorized ADMIN CHAIN without granting restaurant-admin settings to SUPER_ADMIN.'
)
on conflict(key) do nothing;
