begin;
create function public.get_floor_workspace(p_venue uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize(p_venue,array['ADMIN','HOST','WAITER','CASHIER','PASS']::public.user_role[],false);
  if p_venue is null then raise exception 'VENUE_REQUIRED';end if;
  return jsonb_build_object(
    'rooms',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'layout',to_jsonb(l)) order by r.name,r.id)
      from public.rooms r join public.room_layouts l on l.room_id=r.id and l.venue_id=r.venue_id and l.active and not l.archived
      where r.venue_id=p_venue and r.active),'[]'),
    'tables',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object(
      'covers',coalesce((select sum(a.covers) from public.accounts a where a.table_id=t.id and a.floor_released_at is null),0),
      'open_accounts',(select count(*) from public.accounts a where a.table_id=t.id and a.floor_released_at is null),
      'waiter_name',(select display_name from public.staff_profiles where id=private.responsible_waiter(t.id) and active),
      'can_open_account',private.current_role()='WAITER' and private.responsible_waiter(t.id)=private.effective_user_id(),
      'primary_table_id',(select primary_table_id from public.table_merges where secondary_table_id=t.id and split_at is null)
    ) order by t.number,t.id) from public.tables t join public.room_layouts l on l.id=t.layout_id and l.active and not l.archived
      join public.rooms r on r.id=t.room_id and r.active where t.venue_id=p_venue and t.active),'[]'),
    'zones',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'color',color) order by name) from public.zones where venue_id=p_venue and active),'[]'),
    'labels',coalesce((select jsonb_agg(to_jsonb(d) order by sort_order,technical_status) from public.table_status_definitions d where venue_id=p_venue),'[]')
  );
end $$;
grant execute on function public.get_floor_workspace(uuid) to authenticated;
commit;
