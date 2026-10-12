create or replace function public.get_host_reservations(
  p_venue uuid,p_date date,p_service uuid default null,p_status public.reservation_status default null,
  p_search text default '',p_after_time time default null,p_after_id uuid default null,p_limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN','HOST']::public.user_role[],false);
  if p_date is null or p_limit is null or p_limit not between 1 and 100 or length(p_search)>100
     or (p_after_time is null)<>(p_after_id is null) then raise exception 'INVALID_FILTER'; end if;
  with filtered as (
    select r.*,t.name as table_name,s.name as service_name,
      (
        select case when jsonb_typeof(ra.answer)='string'
          then nullif(trim(ra.answer#>>'{}'),'') else ra.answer::text end
        from public.reservation_answers ra
        join public.reservation_form_fields f on f.id=ra.field_id and f.venue_id=ra.venue_id
        where ra.reservation_id=r.id and f.key='special_occasion'
        order by f.sort_order,f.id limit 1
      ) as special_occasion
    from public.reservations r
    join public.services s on s.id=r.service_id
    left join public.tables t on t.id=r.table_id
    where r.venue_id=p_venue and r.service_date=p_date
      and (p_service is null or r.service_id=p_service)
      and (p_status is null or r.status=p_status)
      and (coalesce(p_search,'')='' or strpos(lower(r.first_name||' '||r.last_name||' '||r.phone),lower(p_search))>0)
  ), page as (
    select * from filtered
    where p_after_id is null or (slot_time,id)>(p_after_time,p_after_id)
    order by slot_time,id limit p_limit+1
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(to_jsonb(limited) order by slot_time,id)
      from (select * from page order by slot_time,id limit p_limit) limited),'[]'),
    'has_more',(select count(*)>p_limit from page),
    'total',(select count(*) from filtered),
    'covers',(select coalesce(sum(party_size),0) from filtered where status not in ('CANCELLED','NO_SHOW')),
    'arrived',(
      select count(*) from public.reservations r
      where r.venue_id=p_venue and r.service_date=p_date
        and (p_service is null or r.service_id=p_service)
        and r.status='ARRIVED'
    ),
    'requested',(
      select count(*) from public.reservations r
      where r.venue_id=p_venue and r.service_date=p_date
        and (p_service is null or r.service_id=p_service)
        and r.status='REQUESTED'
    )
  ) into result;
  return result;
end $$;

revoke all on function public.get_host_reservations(uuid,date,uuid,public.reservation_status,text,time,uuid,integer) from public, anon;
grant execute on function public.get_host_reservations(uuid,date,uuid,public.reservation_status,text,time,uuid,integer) to authenticated, service_role;
notify pgrst,'reload schema';
