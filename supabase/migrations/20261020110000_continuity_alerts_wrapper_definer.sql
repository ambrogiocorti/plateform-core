-- continuity-retention-worker calls public.reconcile_all_continuity_alerts() as service_role, which
-- has no USAGE on schema private, so the call always failed with 42501 and only the postgres cron
-- reconciled alerts. The wrapper now runs with its owner's rights; body and grants are unchanged.
alter function public.reconcile_all_continuity_alerts() security definer set search_path='';
revoke all on function public.reconcile_all_continuity_alerts() from public,anon,authenticated;
grant execute on function public.reconcile_all_continuity_alerts() to service_role,postgres;
