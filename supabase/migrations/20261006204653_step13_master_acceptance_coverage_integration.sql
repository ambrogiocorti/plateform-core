
insert into private.master_acceptance_requirements(key,section,requirement) values
  ('INTEGRATION_RLS','INTEGRATION','RLS integration'),
  ('INTEGRATION_SUPABASE','INTEGRATION','Supabase platform integration'),
  ('INTEGRATION_RPC','INTEGRATION','RPC integration'),
  ('INTEGRATION_EDGE_FUNCTIONS','INTEGRATION','Edge Functions integration'),
  ('INTEGRATION_AUDIT','INTEGRATION','audit integration'),
  ('INTEGRATION_STORAGE','INTEGRATION','Storage integration'),
  ('INTEGRATION_AUTH','INTEGRATION','Auth integration'),
  ('INTEGRATION_MFA_PATHS','INTEGRATION','MFA paths'),
  ('INTEGRATION_REALTIME','INTEGRATION','Realtime integration'),
  ('INTEGRATION_MULTI_VENUE_ISOLATION','INTEGRATION','multi-venue isolation'),
  ('INTEGRATION_IDEMPOTENCY','INTEGRATION','idempotency integration'),
  ('INTEGRATION_MIGRATIONS','INTEGRATION','migration integration'),
  ('INTEGRATION_MESSAGING_PROVIDER_ADAPTER','INTEGRATION','messaging provider adapter/mock integration'),
  ('INTEGRATION_DEPOSIT_WEBHOOK_CALLBACK','INTEGRATION','reservation deposit webhook/callback integration'),
  ('INTEGRATION_FOOD_COST_HISTORY','INTEGRATION','food cost calculation with cost history'),
  ('INTEGRATION_TAKEAWAY_ATOMIC_AVAILABILITY','INTEGRATION','takeaway plus atomic availability')
on conflict(key) do nothing;
