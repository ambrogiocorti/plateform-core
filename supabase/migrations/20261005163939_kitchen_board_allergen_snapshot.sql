create or replace function public.get_kitchen_board(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform private.authorize(
    p_venue,
    array['ADMIN','KITCHEN_ADMIN','KITCHEN_STAFF','PASS','WAITER']::public.user_role[],
    false
  );

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',i.id,
        'order_id',o.id,
        'step_id',s.id,
        'step_number',s.step_number,
        'step_status',s.status,
        'table_name',t.name,
        'table_number',t.number,
        'dish_name',i.dish_name,
        'quantity',i.quantity,
        'status',i.status,
        'station_id',i.station_id,
        'version',i.version,
        'created_at',o.created_at,
        'started_at',i.started_at,
        'can_prepare',private.can_work_station(p_venue,i.station_id),
        'can_deliver',
          private.current_role()='WAITER'
          and (
            private.responsible_waiter(t.id)=private.effective_user_id()
            or exists(
              select 1
              from public.table_assignments ta_runner
              where ta_runner.venue_id=p_venue
                and ta_runner.waiter_id=private.effective_user_id()
                and ta_runner.mode='RUNNER'
                and ta_runner.active
            )
          ),
        'removed_ingredients',
          coalesce((
            select jsonb_agg(ingredient_name order by ingredient_name)
            from public.order_item_removed_ingredients
            where order_item_id=i.id
          ),'[]'::jsonb),
        'variants',
          coalesce((
            select jsonb_agg(
              jsonb_build_object('group',group_name,'option',option_name)
              order by group_name,option_name
            )
            from public.order_item_variants
            where order_item_id=i.id
          ),'[]'::jsonb),
        'allergens',coalesce(i.allergen_snapshot,'[]'::jsonb)
      )
      order by o.created_at,s.step_number,i.dish_name
    )
    from public.order_items i
    join public.orders o on o.id=i.order_id
    join public.order_steps s on s.id=i.step_id
    join public.accounts a on a.id=o.account_id
    join public.tables t on t.id=a.table_id
    where i.venue_id=p_venue
      and i.status not in ('SERVED','CANCELLED')
      and a.floor_released_at is null
      and (
        private.is_role(array['ADMIN','KITCHEN_ADMIN','PASS']::public.user_role[])
        or (
          private.current_role()='WAITER'
          and (
            private.responsible_waiter(t.id)=private.effective_user_id()
            or (
              s.status='READY'
              and exists(
                select 1
                from public.table_assignments ta
                where ta.venue_id=p_venue
                  and ta.waiter_id=private.effective_user_id()
                  and ta.mode='RUNNER'
                  and ta.active
              )
            )
          )
        )
        or (
          private.current_role()='KITCHEN_STAFF'
          and exists(
            select 1
            from public.station_staff_assignments sa
            where sa.user_id=private.effective_user_id()
              and sa.venue_id=p_venue
              and sa.active
              and (
                sa.station_id=i.station_id
                or exists(
                  select 1
                  from public.dish_station_assignments da
                  where da.venue_id=p_venue
                    and da.dish_id=i.dish_id
                    and da.station_id=sa.station_id
                )
              )
          )
        )
      )
  ),'[]'::jsonb);
end
$$;

revoke all on function public.get_kitchen_board(uuid) from public, anon;
grant execute on function public.get_kitchen_board(uuid) to authenticated, service_role;
