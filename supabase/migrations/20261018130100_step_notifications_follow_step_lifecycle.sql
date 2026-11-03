-- STEP 7 / §56 Notification Center: le notifiche operative di uno step restavano NEW per sempre
-- dopo che lo step era stato liberato dal Pass e servito al tavolo, riempiendo il centro
-- notifiche di avvisi già gestiti durante il servizio. Ora seguono lo stato dello step:
--   * STEP_PREPARED (al Pass) si risolve quando lo step lascia ACTIVE (liberato, servito,
--     annullato);
--   * STEP_READY (al cameriere/runner) si risolve quando lo step lascia READY (servito,
--     annullato o rimandato in cucina con un reso RIFARE).
-- Le notifiche già scadute o risolte non vengono toccate. Ogni cambio di stato passa dal
-- trigger audit_mutation di public.notifications ed è inoltre registrato con un evento audit
-- dedicato attribuito alla risorsa step.

create or replace function private.resolve_step_notifications()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare categories text[]:=array[]::text[]; resolved integer;
begin
  if new.status is not distinct from old.status then return new; end if;
  if old.status='ACTIVE' then categories:=array_append(categories,'STEP_PREPARED'); end if;
  if old.status='READY' then categories:=array_append(categories,'STEP_READY'); end if;
  if cardinality(categories)=0 then return new; end if;
  update public.notifications
     set status='RESOLVED',
         acknowledged_at=coalesce(acknowledged_at,clock_timestamp()),
         resolved_at=clock_timestamp()
   where resource_type='order_steps'
     and resource_id=new.id
     and category=any(categories)
     and status in ('NEW','ACKNOWLEDGED');
  get diagnostics resolved=row_count;
  if resolved>0 then
    perform private.audit(
      'NOTIFICATIONS_AUTO_RESOLVED','order_steps',new.id,new.venue_id,
      jsonb_build_object('status',old.status),
      jsonb_build_object('status',new.status,'categories',to_jsonb(categories),'count',resolved)
    );
  end if;
  return new;
end $$;

revoke all on function private.resolve_step_notifications() from public, anon, authenticated;

drop trigger if exists resolve_step_notifications on public.order_steps;
create trigger resolve_step_notifications
  after update of status on public.order_steps
  for each row
  when (old.status is distinct from new.status)
  execute function private.resolve_step_notifications();
