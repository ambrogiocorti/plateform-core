
update public.restaurant_settings
set retention = retention
  || jsonb_build_object(
    'enabled',false,
    'error_days',coalesce((retention->>'error_days')::integer,30),
    'signal_days',coalesce((retention->>'signal_days')::integer,30)
  )
where id
  and not (retention ? 'configured_at');

select cron.schedule(
  'plateform-data-retention',
  '17 3 * * *',
  'select public.run_data_retention(500);'
)
where not exists(
  select 1 from cron.job where jobname='plateform-data-retention'
);

insert into private.release_gate_checks(
  key,category,required,status,evidence
) values(
  'PRIVACY_RETENTION_CONFIGURED',
  'PRIVACY',
  true,
  'PENDING',
  'Technical retention engine is installed, but real retention terms must be explicitly configured and approved for the customer before go-live.'
)
on conflict(key) do nothing;
