
insert into private.release_test_catalog(key,category,required,description)
values(
  'TECHNICAL_INCIDENT_ROLE_ISOLATION',
  'SECURITY',
  true,
  'Incident and incident-event visibility is limited to SUPER_ADMIN and venue ADMIN scope; operational roles cannot read technical incident data.'
)
on conflict(key) do nothing;
