begin;

alter function public.get_operational_statistics(uuid,date,date) rename to analytics_step8_base;
alter function public.analytics_step8_base(uuid,date,date) set schema private;
revoke all on function private.analytics_step8_base(uuid,date,date) from public,anon,authenticated;

create function public.get_operational_statistics(p_venue uuid,p_start date,p_end date) returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  result jsonb;
  extra jsonb;
  venues uuid[];
begin
  if not coalesce((select licensed from public.feature_flags where name='ADVANCED_ANALYTICS'),false) then
    raise exception 'FEATURE_NOT_LICENSED';
  end if;
  result:=private.analytics_step8_base(p_venue,p_start,p_end);
  select array_agg(id) into venues
    from public.venues
   where active and private.has_venue(id) and (p_venue is null or id=p_venue);

  with active_services as (
    select s.id,s.venue_id,s.name,s.weekdays,r.max_covers_service,v.timezone
      from public.services s
      join public.venues v on v.id=s.venue_id
      left join public.service_booking_rules r on r.service_id=s.id and r.venue_id=s.venue_id
     where s.active and s.venue_id=any(venues)
  ), service_capacity as (
    select s.id,s.name,s.max_covers_service,
           case when s.max_covers_service is null then null::bigint
                else s.max_covers_service * count(d.day)::bigint end capacity_covers
      from active_services s
      left join lateral (
        select day::date
          from generate_series(p_start,p_end,interval '1 day') day
         where extract(isodow from day)::integer=any(s.weekdays)
      ) d(day) on true
     group by s.id,s.name,s.max_covers_service
  ), service_usage as (
    select s.id,coalesce(sum(r.party_size) filter(where r.status in ('RESERVED','ARRIVED','SEATED','COMPLETED')),0)::bigint used_covers
      from active_services s
      left join public.reservations r on r.service_id=s.id and r.venue_id=s.venue_id and r.service_date between p_start and p_end
     group by s.id
  ), capacity as (
    select c.id,c.name,c.capacity_covers,u.used_covers,
           case when c.capacity_covers is null or c.capacity_covers=0 then null::numeric
                else round(100.0*u.used_covers/c.capacity_covers,2) end utilization_percent
      from service_capacity c join service_usage u using(id)
  )
  select jsonb_build_object(
    'average_stay_seconds',(
      select round(avg(extract(epoch from a.closed_at-a.created_at)))
        from public.accounts a join public.venues v on v.id=a.venue_id
       where a.venue_id=any(venues) and a.closed_at is not null and a.closed_at>=a.created_at
         and a.closed_at>=p_start::timestamp at time zone v.timezone
         and a.closed_at<(p_end+1)::timestamp at time zone v.timezone
    ),
    'cancelled_items',coalesce((
      select sum(i.quantity)
        from public.order_items i join public.venues v on v.id=i.venue_id
       where i.venue_id=any(venues) and i.status='CANCELLED'
         and i.updated_at>=p_start::timestamp at time zone v.timezone
         and i.updated_at<(p_end+1)::timestamp at time zone v.timezone
    ),0),
    'operational_errors',(
      select count(*)
        from public.audit_log a join public.venues v on v.id=a.venue_id
       where a.venue_id=any(venues) and a.result in ('FAILED','CONFLICT')
         and a.created_at>=p_start::timestamp at time zone v.timezone
         and a.created_at<(p_end+1)::timestamp at time zone v.timezone
    ),
    'incidents',(
      select count(*) from public.incidents i
       where i.venue_id=any(venues)
         and i.started_at>=p_start::timestamptz and i.started_at<(p_end+1)::timestamptz
    ),
    'open_incidents',(
      select count(*) from public.incidents i where i.venue_id=any(venues) and i.status<>'RESOLVED'
    ),
    'capacity_services',coalesce((
      select jsonb_agg(to_jsonb(c) order by c.name,c.id) from capacity c
    ),'[]'::jsonb)
  ) into extra;
  return result||extra;
end $$;

grant execute on function public.get_operational_statistics(uuid,date,date) to authenticated;

commit;