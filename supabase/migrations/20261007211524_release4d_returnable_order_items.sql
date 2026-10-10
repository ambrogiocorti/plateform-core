
create or replace function private.prevent_duplicate_return_cancel_request()
returns trigger
language plpgsql
set search_path=''
as $$
declare
  v_item uuid;
begin
  if new.kind='RETURN_CANCELLATION' then
    if jsonb_array_length(coalesce(new.payload->'item_ids','[]'::jsonb))<>1 then
      raise exception 'INVALID_ORDER_CHANGE';
    end if;
    v_item:=(new.payload->'item_ids'->>0)::uuid;
    if exists(
      select 1
      from public.order_change_requests r
      where r.status='PENDING'
        and r.kind='RETURN_CANCELLATION'
        and r.order_id=new.order_id
        and r.payload->'item_ids' ? v_item::text
    ) then
      raise exception 'RETURN_CANCELLATION_PENDING';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists prevent_duplicate_return_cancel_request on public.order_change_requests;
create trigger prevent_duplicate_return_cancel_request
before insert on public.order_change_requests
for each row execute function private.prevent_duplicate_return_cancel_request();

create or replace function public.get_returnable_order_items(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform private.authorize(
    p_venue,
    array['PASS','KITCHEN_ADMIN']::public.user_role[],
    false
  );

  if not exists(
    select 1 from public.venue_settings
    where venue_id=p_venue and returns_enabled
  ) then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',i.id,
        'order_id',o.id,
        'account_id',a.id,
        'account_name',a.account_name,
        'table_name',t.name,
        'dish_name',i.dish_name,
        'quantity',i.quantity,
        'status',i.status,
        'version',i.version,
        'pending_cancel_request',exists(
          select 1
          from public.order_change_requests r
          where r.order_id=o.id
            and r.status='PENDING'
            and r.kind='RETURN_CANCELLATION'
            and r.payload->'item_ids' ? i.id::text
        ),
        'last_return_action',(
          select ri.action
          from public.returned_items ri
          where ri.order_item_id=i.id
          order by ri.created_at desc,ri.id desc
          limit 1
        )
      )
      order by o.created_at desc,i.created_at desc,i.id
    )
    from public.order_items i
    join public.orders o on o.id=i.order_id
    join public.accounts a on a.id=o.account_id
    left join public.tables t on t.id=a.table_id
    where i.venue_id=p_venue
      and i.status in ('READY','SERVED')
      and a.floor_released_at is null
  ),'[]'::jsonb);
end
$$;

revoke all on function public.get_returnable_order_items(uuid) from public,anon;
grant execute on function public.get_returnable_order_items(uuid) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_returnable_order_items(uuid)','authenticated')
on conflict do nothing;
