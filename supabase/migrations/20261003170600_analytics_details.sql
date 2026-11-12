begin;
-- Admissions are a historical measure: a later financial merge must not move yesterday's covers.
alter table public.accounts add column admitted_covers integer not null default 0 check(admitted_covers between 0 and 1000);
update public.accounts set admitted_covers=case when financial_partition then 0 else covers end;
create function private.account_admission_snapshot() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then new.admitted_covers:=case when new.financial_partition then 0 else new.covers end;
  elsif new.admitted_covers is distinct from old.admitted_covers then raise exception 'IMMUTABLE_ADMISSION';end if;
  return new;
end $$;
create trigger admission_snapshot before insert or update on public.accounts for each row execute function private.account_admission_snapshot();
alter function public.get_operational_statistics(uuid,date,date) rename to statistics_base;
alter function public.statistics_base(uuid,date,date) set schema private;
revoke all on function private.statistics_base(uuid,date,date) from public,anon,authenticated;
create function public.get_operational_statistics(p_venue uuid,p_start date,p_end date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; details jsonb; venues uuid[];
begin
  result:=private.statistics_base(p_venue,p_start,p_end);
  select array_agg(id) into venues from public.venues where active and private.has_venue(id) and (p_venue is null or id=p_venue);
  with bookings as (select * from public.reservations where venue_id=any(venues) and service_date between p_start and p_end),
    accounts as (select a.* from public.accounts a join public.venues v on v.id=a.venue_id where a.venue_id=any(venues) and a.created_at>=p_start::timestamp at time zone v.timezone and a.created_at<(p_end+1)::timestamp at time zone v.timezone),
    closed as (select a.id from public.accounts a join public.venues v on v.id=a.venue_id where a.venue_id=any(venues) and a.closed_at>=p_start::timestamp at time zone v.timezone and a.closed_at<(p_end+1)::timestamp at time zone v.timezone),
    items as (select i.* from public.order_items i join public.orders o on o.id=i.order_id join public.venues v on v.id=i.venue_id where i.venue_id=any(venues) and o.created_at>=p_start::timestamp at time zone v.timezone and o.created_at<(p_end+1)::timestamp at time zone v.timezone),
    calls as (select c.* from public.waiter_calls c join public.venues v on v.id=c.venue_id where c.venue_id=any(venues) and c.created_at>=p_start::timestamp at time zone v.timezone and c.created_at<(p_end+1)::timestamp at time zone v.timezone),
    movements as (select j.* from public.cash_journal j join public.venues v on v.id=j.venue_id where j.venue_id=any(venues) and j.created_at>=p_start::timestamp at time zone v.timezone and j.created_at<(p_end+1)::timestamp at time zone v.timezone)
  select jsonb_build_object(
    'covers',coalesce((select sum(admitted_covers) from accounts),0),
    'closed_accounts',(select count(*) from closed),
    'average_check_cents',(select round(avg(total)) from(select coalesce(sum(u.gross_cents-u.discount_cents) filter(where u.voided_at is null),0) total from closed c left join public.billing_units u on u.account_id=c.id group by c.id)x),
    'no_shows',(select count(*) from bookings where not walk_in and status='NO_SHOW'),
    'cancelled_reservations',(select count(*) from bookings where not walk_in and status='CANCELLED'),
    'walk_ins',(select count(*) from bookings where walk_in),
    'no_show_percent',(select round(100.0*count(*) filter(where status='NO_SHOW')/nullif(count(*) filter(where status not in ('REQUESTED','CANCELLED')),0),2) from bookings where not walk_in),
    'booking_states',coalesce((select jsonb_agg(to_jsonb(x) order by status) from(select status,count(*) reservations,sum(party_size) covers from bookings group by status)x),'[]'),
    'booking_slots',coalesce((select jsonb_agg(to_jsonb(x) order by slot_time) from(select slot_time::text,count(*) reservations,sum(party_size) covers from bookings where status not in ('NO_SHOW','CANCELLED') group by slot_time)x),'[]'),
    'categories',coalesce((select jsonb_agg(to_jsonb(x) order by amount_cents desc,name) from(select i.category_name name,count(*) quantity,sum(u.gross_cents-u.discount_cents) amount_cents from items i join public.billing_units u on u.order_item_id=i.id and u.voided_at is null group by i.category_name)x),'[]'),
    'stations',coalesce((select jsonb_agg(to_jsonb(x) order by name) from(select s.name,s.id,count(*) items,round(avg(extract(epoch from i.ready_at-i.started_at)) filter(where i.ready_at>=i.started_at)) preparation_seconds,round(avg(extract(epoch from i.served_at-i.ready_at)) filter(where i.served_at>=i.ready_at)) delivery_seconds from items i join public.stations s on s.id=i.station_id group by s.name,s.id)x),'[]'),
    'returns',(select count(*) from public.returned_items r join public.venues v on v.id=r.venue_id where r.venue_id=any(venues) and r.created_at>=p_start::timestamp at time zone v.timezone and r.created_at<(p_end+1)::timestamp at time zone v.timezone),
    'calls',(select count(*) from calls),
    'call_acceptance_seconds',(select round(avg(extract(epoch from accepted_at-created_at))) from calls where accepted_at>=created_at),
    'call_completion_seconds',(select round(avg(extract(epoch from completed_at-created_at))) from calls where completed_at>=created_at),
    'registers',coalesce((select jsonb_agg(to_jsonb(x) order by name) from(select r.id,r.name,sum(m.amount_cents) amount_cents,sum(m.tip_cents) tip_cents from movements m join public.cash_registers r on r.id=m.cash_register_id group by r.id,r.name)x),'[]'),
    'services',coalesce((select jsonb_agg(to_jsonb(x) order by name) from(select coalesce(s.name,'Servizio senza turno') name,sum(m.amount_cents) amount_cents,sum(m.tip_cents) tip_cents from movements m join public.service_sessions ss on ss.id=m.service_session_id left join public.services s on s.id=ss.service_id group by s.name)x),'[]')
  ) into details;
  return result||details;
end $$;
grant execute on function public.get_operational_statistics(uuid,date,date) to authenticated;
create index account_admission_period on public.accounts(venue_id,created_at);
create index account_closure_period on public.accounts(venue_id,closed_at) where closed_at is not null;
create index order_period on public.orders(venue_id,created_at);
create index call_period on public.waiter_calls(venue_id,created_at);
commit;
