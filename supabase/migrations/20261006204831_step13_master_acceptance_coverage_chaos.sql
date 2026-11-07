
insert into private.master_acceptance_requirements(key,section,requirement) values
  ('CHAOS_DATABASE_UNAVAILABLE','CHAOS','database unavailable during operation'),
  ('CHAOS_REALTIME_DISCONNECTED','CHAOS','Realtime disconnected during service'),
  ('CHAOS_BROWSER_CLOSED_POST_PAYMENT_COMMIT','CHAOS','browser closed after create_payment before response'),
  ('CHAOS_PAYMENT_WEBHOOK_DUPLICATE','CHAOS','duplicate payment webhook'),
  ('CHAOS_PAYMENT_WEBHOOK_OUT_OF_ORDER','CHAOS','out-of-order payment webhook'),
  ('CHAOS_TWO_REGISTERS_SAME_BALANCE','CHAOS','two registers attempt same balance'),
  ('CHAOS_LAST_PORTION_TWO_DEVICES','CHAOS','two devices order the last portion'),
  ('CHAOS_PRINTER_OFFLINE_AFTER_ENQUEUE','CHAOS','printer offline after enqueue'),
  ('CHAOS_OFFLINE_USER_REVOKED','CHAOS','user revoked while device is offline'),
  ('CHAOS_EDGE_FUNCTION_RETRY','CHAOS','Edge Function retry'),
  ('CHAOS_NETWORK_TIMEOUT_AFTER_COMMIT','CHAOS','network timeout after server commit'),
  ('CHAOS_MESSAGING_PROVIDER_UNAVAILABLE_REMINDER','CHAOS','messaging provider unavailable during reminder'),
  ('CHAOS_DEPOSIT_CALLBACK_DUPLICATE_OUT_OF_ORDER','CHAOS','deposit callback duplicated or out of order'),
  ('CHAOS_WAITLIST_LAST_SLOT_RACE','CHAOS','two clients accept the last waitlist slot'),
  ('CHAOS_TAKEAWAY_LAST_SLOT_RACE','CHAOS','two clients attempt the last takeaway slot'),
  ('CHAOS_INGREDIENT_COST_UPDATE_DURING_ANALYTICS','CHAOS','ingredient cost changes during analytics calculation')
on conflict(key) do nothing;
