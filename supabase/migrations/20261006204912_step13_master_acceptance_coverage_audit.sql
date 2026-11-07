
insert into private.master_acceptance_requirements(key,section,requirement) values
  ('AUDIT_SENSITIVE_OPERATIONS','AUDIT','sensitive operations generate audit'),
  ('AUDIT_ECONOMIC_CHANGES','AUDIT','economic changes generate audit'),
  ('AUDIT_ROLE_SCOPE_CHANGES','AUDIT','role/scope changes generate audit'),
  ('AUDIT_CUSTOMER_ACTIONS','AUDIT','relevant customer actions generate audit where required'),
  ('AUDIT_SYSTEM_ACTIONS','AUDIT','relevant system actions generate audit'),
  ('AUDIT_IMPERSONATION_ACTORS','AUDIT','impersonation records real and impersonated actors'),
  ('AUDIT_OLD_NEW_CORRECTNESS','AUDIT','old/new values are correct where applicable'),
  ('AUDIT_SUPER_ADMIN_READ','AUDIT','authorized Super Admin can read audit'),
  ('AUDIT_ADMIN_RESTRICTED','AUDIT','Admin cannot read full technical audit'),
  ('AUDIT_IMMUTABLE','AUDIT','audit cannot be modified or deleted'),
  ('AUDIT_NAVIGATION_TO_TELEMETRY','AUDIT','pure navigation goes to telemetry, not security audit'),
  ('AUDIT_SENSITIVE_DATA_MINIMIZED','AUDIT','sensitive data is redacted/minimized')
on conflict(key) do nothing;
