begin;

create or replace function private.reconcile_restore_cutover_alert()
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare settings private.continuity_settings; pending public.restore_jobs; condition_active boolean;
begin
  select * into settings from private.continuity_settings where id;
  if settings.id is null then raise exception 'CONTINUITY_SETTINGS_REQUIRED'; end if;

  select * into pending
    from public.restore_jobs
   where mode='RESTORE' and status='CUTOVER_REQUIRED'
   order by verified_at nulls last,updated_at,id
   limit 1;

  condition_active := pending.id is not null
    and coalesce(pending.verified_at,pending.updated_at)
      < now()-make_interval(mins=>settings.rto_target_minutes);

  return private.reconcile_continuity_incident(
    'CONTINUITY_CUTOVER_PENDING',
    condition_active,
    'CRITICAL',
    'Cutover restore oltre target RTO',
    format(
      'Un replacement verificato attende il cutover oltre il target RTO di %s minuti.',
      settings.rto_target_minutes
    ),
    'Completare i gate di piattaforma e smoke test sul replacement, quindi confermare o abbandonare il cutover con step-up Super Admin.'
  );
end $$;
revoke all on function private.reconcile_restore_cutover_alert() from public,anon,authenticated;
grant execute on function private.reconcile_restore_cutover_alert() to service_role,postgres;

create or replace function public.reconcile_all_continuity_alerts()
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'continuity',public.reconcile_continuity_alerts(),
    'cutover',private.reconcile_restore_cutover_alert()
  )
$$;
revoke all on function public.reconcile_all_continuity_alerts() from public,anon,authenticated;
grant execute on function public.reconcile_all_continuity_alerts() to service_role,postgres;

do $$ begin
  if exists(select 1 from cron.job where jobname='plateform-continuity-alerts') then
    perform cron.unschedule('plateform-continuity-alerts');
  end if;
end $$;

select cron.schedule(
  'plateform-continuity-alerts',
  '*/10 * * * *',
  $cron$select public.reconcile_all_continuity_alerts();$cron$
);

select public.reconcile_all_continuity_alerts();

commit;