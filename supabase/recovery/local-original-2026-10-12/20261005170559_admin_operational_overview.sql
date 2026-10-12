create or replace function public.get_admin_operational_overview(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  local_date date;
  actor uuid;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[],false);
  actor := private.effective_user_id();

  select (now() at time zone v.timezone)::date
  into local_date
  from public.venues v
  where v.id=p_venue;

  if local_date is null then
    raise exception 'VENUE_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'generated_at',now(),
    'service_date',local_date,
    'tables',jsonb_build_object(
      'total',(select count(*)::integer from public.tables t where t.venue_id=p_venue and t.active),
      'available',(select count(*)::integer from public.tables t where t.venue_id=p_venue and t.active and t.technical_status='AVAILABLE'),
      'occupied',(select count(*)::integer from public.tables t where t.venue_id=p_venue and t.active and t.technical_status in ('OCCUPIED','ORDERING','WAITING_SERVICE')),
      'waiting_bill',(select count(*)::integer from public.tables t where t.venue_id=p_venue and t.active and t.technical_status in ('WAITING_BILL','PAYMENT')),
      'to_reset',(select count(*)::integer from public.tables t where t.venue_id=p_venue and t.active and t.technical_status='TO_RESET')
    ),
    'kitchen',jsonb_build_object(
      'active_items',(select count(*)::integer from public.order_items i join public.orders o on o.id=i.order_id join public.accounts a on a.id=o.account_id where i.venue_id=p_venue and i.status not in ('SERVED','CANCELLED') and a.floor_released_at is null),
      'ready',(select count(*)::integer from public.order_items i join public.orders o on o.id=i.order_id join public.accounts a on a.id=o.account_id where i.venue_id=p_venue and i.status='READY' and a.floor_released_at is null),
      'delayed',(select count(*)::integer from public.order_items i join public.orders o on o.id=i.order_id join public.accounts a on a.id=o.account_id where i.venue_id=p_venue and i.status not in ('SERVED','CANCELLED') and a.floor_released_at is null and o.created_at <= now()-interval '10 minutes'),
      'critical',(select count(*)::integer from public.order_items i join public.orders o on o.id=i.order_id join public.accounts a on a.id=o.account_id where i.venue_id=p_venue and i.status not in ('SERVED','CANCELLED') and a.floor_released_at is null and o.created_at <= now()-interval '20 minutes')
    ),
    'reservations',jsonb_build_object(
      'today',(select count(*)::integer from public.reservations r where r.venue_id=p_venue and r.service_date=local_date and r.status not in ('CANCELLED','NO_SHOW')),
      'requested',(select count(*)::integer from public.reservations r where r.venue_id=p_venue and r.service_date=local_date and r.status='REQUESTED'),
      'arrived',(select count(*)::integer from public.reservations r where r.venue_id=p_venue and r.service_date=local_date and r.status='ARRIVED'),
      'seated',(select count(*)::integer from public.reservations r where r.venue_id=p_venue and r.service_date=local_date and r.status='SEATED')
    ),
    'calls',jsonb_build_object(
      'new',(select count(*)::integer from public.waiter_calls c where c.venue_id=p_venue and c.status='NEW'),
      'accepted',(select count(*)::integer from public.waiter_calls c where c.venue_id=p_venue and c.status='ACCEPTED')
    ),
    'cash',jsonb_build_object(
      'open_registers',(select count(*)::integer from public.cash_registers c where c.venue_id=p_venue and c.active and c.status='OPEN'),
      'open_services',(select count(*)::integer from public.service_sessions s where s.venue_id=p_venue and s.status='OPEN'),
      'pending_payments',(select count(*)::integer from public.payments p where p.venue_id=p_venue and p.status='PENDING'),
      'pending_reconciliations',(select count(*)::integer from public.cash_reconciliation_requests r where r.venue_id=p_venue and r.status='PENDING')
    ),
    'attention',jsonb_build_object(
      'notifications',(select count(*)::integer from public.notifications n where n.venue_id=p_venue and n.status in ('NEW','ACKNOWLEDGED') and (n.recipient_user_id=actor or n.recipient_role='ADMIN')),
      'high_notifications',(select count(*)::integer from public.notifications n where n.venue_id=p_venue and n.status in ('NEW','ACKNOWLEDGED') and n.priority in ('INCIDENT','CRITICAL') and (n.recipient_user_id=actor or n.recipient_role='ADMIN')),
      'conflicts',(select count(*)::integer from public.sync_conflicts c where c.venue_id=p_venue and c.status='OPEN'),
      'failed_prints',(select count(*)::integer from public.print_jobs p where p.venue_id=p_venue and p.status='FAILED'),
      'queued_prints',(select count(*)::integer from public.print_jobs p where p.venue_id=p_venue and p.status in ('QUEUED','SENT')),
      'order_changes',(select count(*)::integer from public.order_change_requests r where r.venue_id=p_venue and r.status='PENDING'),
      'open_incidents',(select count(*)::integer from public.incidents i where i.venue_id=p_venue and i.status='OPEN')
    )
  );
end
$$;

revoke all on function public.get_admin_operational_overview(uuid) from public, anon;
grant execute on function public.get_admin_operational_overview(uuid) to authenticated, service_role;
