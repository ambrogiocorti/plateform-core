begin;

create or replace function private.layout_editable(p_layout uuid) returns void
language plpgsql
security definer
set search_path=''
as $$
declare l public.room_layouts;
begin
  if not coalesce((select licensed from public.feature_flags where name='ADVANCED_ROOM_EDITOR'),false) then
    raise exception 'FEATURE_NOT_LICENSED';
  end if;
  select * into l from public.room_layouts where id=p_layout;
  if l.id is null or l.archived then raise exception 'NOT_FOUND'; end if;
  if exists(
    select 1
      from public.tables t
     where t.room_id=l.room_id
       and (
         t.technical_status not in ('AVAILABLE','TO_RESET')
         or exists(select 1 from public.accounts a where a.table_id=t.id and a.floor_released_at is null)
         or exists(select 1 from public.reservations r where r.table_id=t.id and r.status in ('ARRIVED','SEATED'))
         or exists(select 1 from public.table_merges m where (m.primary_table_id=t.id or m.secondary_table_id=t.id) and m.split_at is null)
       )
  ) then
    raise exception 'LAYOUT_IN_SERVICE';
  end if;
end $$;

commit;