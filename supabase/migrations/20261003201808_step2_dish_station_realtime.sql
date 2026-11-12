begin;
create or replace function private.signal_station_configuration() returns trigger
language plpgsql security definer set search_path='' as $$
declare data jsonb:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  venue uuid:=(data->>'venue_id')::uuid;
  station uuid;
  resource uuid;
  dish uuid;
  row record;
begin
  if tg_table_name='stations' then
    station:=(data->>'id')::uuid;
    resource:=station;
  else
    station:=(data->>'station_id')::uuid;
    dish:=(data->>'dish_id')::uuid;
    resource:=dish;
  end if;
  perform private.emit_signal('CONFIG',venue,resource);
  for row in select distinct user_id from public.station_staff_assignments
    where venue_id=venue and station_id=station and active
  loop
    perform private.emit_signal('ACCESS',venue,null,null,row.user_id);
  end loop;
  for row in
    select distinct i.order_id,o.account_id
    from public.order_items i join public.orders o on o.id=i.order_id
    where i.venue_id=venue
      and i.status not in ('SERVED','CANCELLED')
      and ((tg_table_name='stations' and i.station_id=station)
        or (tg_table_name='dish_station_assignments' and i.dish_id=dish))
  loop
    perform private.emit_signal('KITCHEN',venue,row.order_id,row.account_id);
  end loop;
  return coalesce(new,old);
end $$;
commit;