begin;

create or replace function private.prevent_duplicate_reservation() returns trigger
language plpgsql set search_path='' as $$
begin
  if not new.walk_in and new.status not in ('CANCELLED','NO_SHOW') and exists (
    select 1 from public.reservations r
    where r.id is distinct from new.id
      and r.venue_id=new.venue_id and r.service_id=new.service_id
      and r.service_date=new.service_date and r.slot_time=new.slot_time
      and r.phone=new.phone and not r.walk_in
      and r.status not in ('CANCELLED','NO_SHOW')
  ) then
    raise exception 'BOOKING_DUPLICATE' using errcode='23505';
  end if;
  return new;
end $$;

drop trigger if exists prevent_duplicate_reservation on public.reservations;
create trigger prevent_duplicate_reservation
before insert or update of venue_id,service_id,service_date,slot_time,phone,status,walk_in
on public.reservations for each row execute function private.prevent_duplicate_reservation();

create or replace function private.sync_standard_reservation_answer() returns trigger
language plpgsql security definer set search_path='' as $$
declare field_key text; value_text text;
begin
  select f.key into field_key from public.reservation_form_fields f
  where f.id=new.field_id and f.venue_id=new.venue_id;
  if field_key not in ('note','allergies') then return new; end if;
  if jsonb_typeof(new.answer)<>'string' then raise exception 'INVALID_FORM_TEXT'; end if;
  value_text:=nullif(trim(new.answer#>>'{}'),'');
  if length(coalesce(value_text,''))>2000 then raise exception 'INVALID_FORM_TEXT'; end if;
  if field_key='note' then
    update public.reservations set customer_note=value_text
    where id=new.reservation_id and venue_id=new.venue_id;
  else
    update public.reservations set allergies=value_text
    where id=new.reservation_id and venue_id=new.venue_id;
  end if;
  return new;
end $$;

drop trigger if exists sync_standard_reservation_answer on public.reservation_answers;
create trigger sync_standard_reservation_answer
after insert or update of answer,field_id on public.reservation_answers
for each row execute function private.sync_standard_reservation_answer();

update public.reservations r
set customer_note=coalesce(r.customer_note, x.note),
    allergies=coalesce(r.allergies, x.allergies)
from (
  select ra.reservation_id,
    max(case when f.key='note' and jsonb_typeof(ra.answer)='string'
      then nullif(trim(ra.answer#>>'{}'),'') end) as note,
    max(case when f.key='allergies' and jsonb_typeof(ra.answer)='string'
      then nullif(trim(ra.answer#>>'{}'),'') end) as allergies
  from public.reservation_answers ra
  join public.reservation_form_fields f on f.id=ra.field_id and f.venue_id=ra.venue_id
  where f.key in ('note','allergies')
  group by ra.reservation_id
) x
where r.id=x.reservation_id
  and ((r.customer_note is null and x.note is not null)
    or (r.allergies is null and x.allergies is not null));

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
    'arrived',(select count(*) from filtered where status='ARRIVED'),
    'requested',(select count(*) from filtered where status='REQUESTED')
  ) into result;
  return result;
end $$;

notify pgrst,'reload schema';
commit;