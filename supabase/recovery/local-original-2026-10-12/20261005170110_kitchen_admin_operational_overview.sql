create or replace function public.get_kitchen_admin_overview(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform private.authorize(
    p_venue,
    array['ADMIN','KITCHEN_ADMIN']::public.user_role[],
    false
  );

  return (
    with active_items as (
      select i.id,i.step_id,i.station_id,i.status,o.created_at
      from public.order_items i
      join public.orders o on o.id=i.order_id
      join public.accounts a on a.id=o.account_id
      where i.venue_id=p_venue
        and i.status not in ('SERVED','CANCELLED')
        and a.floor_released_at is null
    ),
    station_rows as (
      select s.id,s.name,s.active,
        count(ai.id) filter (where ai.status='RECEIVED')::integer as received,
        count(ai.id) filter (where ai.status='IN_PREPARATION')::integer as in_preparation,
        count(ai.id) filter (where ai.status='READY')::integer as ready,
        count(ai.id) filter (where ai.created_at <= now()-interval '10 minutes')::integer as delayed,
        count(ai.id) filter (where ai.created_at <= now()-interval '20 minutes')::integer as critical,
        min(ai.created_at) as oldest_created_at
      from public.stations s
      left join active_items ai on ai.station_id=s.id
      where s.venue_id=p_venue and s.active
      group by s.id,s.name,s.active
    ),
    recent_returns as (
      select jsonb_build_object(
        'id',r.id,
        'created_at',r.created_at,
        'action',r.action,
        'dish_name',i.dish_name,
        'table_name',t.name,
        'step_number',os.step_number
      ) as value
      from public.returned_items r
      join public.order_items i on i.id=r.order_item_id
      join public.order_steps os on os.id=i.step_id
      join public.orders o on o.id=i.order_id
      join public.accounts a on a.id=o.account_id
      join public.tables t on t.id=a.table_id
      where r.venue_id=p_venue
      order by r.created_at desc,r.id desc
      limit 12
    )
    select jsonb_build_object(
      'summary',jsonb_build_object(
        'steps',(select count(distinct step_id)::integer from active_items),
        'received',(select count(*)::integer from active_items where status='RECEIVED'),
        'in_preparation',(select count(*)::integer from active_items where status='IN_PREPARATION'),
        'ready',(select count(*)::integer from active_items where status='READY'),
        'delayed',(select count(*)::integer from active_items where created_at <= now()-interval '10 minutes'),
        'critical',(select count(*)::integer from active_items where created_at <= now()-interval '20 minutes')
      ),
      'stations',coalesce((select jsonb_agg(to_jsonb(sr) order by sr.critical desc,sr.delayed desc,sr.name) from station_rows sr),'[]'::jsonb),
      'returns',coalesce((select jsonb_agg(value) from recent_returns),'[]'::jsonb)
    )
  );
end
$$;

revoke all on function public.get_kitchen_admin_overview(uuid) from public, anon;
grant execute on function public.get_kitchen_admin_overview(uuid) to authenticated, service_role;
