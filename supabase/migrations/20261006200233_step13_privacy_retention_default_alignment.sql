
alter table public.restaurant_settings
  alter column retention
  set default '{
    "enabled": false,
    "reservation_days": 180,
    "customer_session_days": 30,
    "telemetry_days": 30,
    "error_days": 30,
    "signal_days": 30
  }'::jsonb;
