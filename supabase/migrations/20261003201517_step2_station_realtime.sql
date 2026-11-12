begin;
create function private.signal_station_configuration() returns trigger
language plpgsql security definer set search_path='' as $$
declare data jsonb:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  venue uuid:=(data->>'venue_id')::uuid;
  station uuid;
  resource uuid;
  row record;
begin
  if tg_table_name='stations' then
    station:=(data->>'id')::uuid;
    resource:=station;
  else
    station:=(data->>'station_id')::uuid;
    resource:=(data->>'dish_id')::uuid;
  end if;
  perform private.emit_signal('CONFIG',venue,resource);
  for row in select distinct user_id from public.station_staff_assignments
    where venue_id=venue and station_id=station and active
  loop
    perform private.emit_signal('ACCESS',venue,null,null,row.user_id);
  end loop;
  if tg_table_name='stations' then
    for row in
      select distinct i.order_id,o.account_id
      from public.order_items i join public.orders o on o.id=i.order_id
      where i.venue_id=venue and i.station_id=station and i.status not in ('SERVED','CANCELLED')
    loop
      perform private.emit_signal('KITCHEN',venue,row.order_id,row.account_id);
    end loop;
  end if;
  return coalesce(new,old);
end $$;
revoke all on function private.signal_station_configuration() from public,anon,authenticated,service_role;
create trigger realtime_station_configuration
  after insert or update or delete on public.stations
  for each row execute function private.signal_station_configuration();
create trigger realtime_dish_station_configuration
  after insert or update or delete on public.dish_station_assignments
  for each row execute function private.signal_station_configuration();
commit;