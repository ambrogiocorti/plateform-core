
create or replace function public.get_accounts_center(
  p_venue uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_actor uuid;
begin
  if p_venue is null or p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_FILTER';
  end if;

  v_actor:=private.authorize(
    p_venue,
    array['ADMIN','WAITER','CASHIER']::public.user_role[]
  );

  return jsonb_build_object(
    'items',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',a.id,
          'venue_id',a.venue_id,
          'table_id',a.table_id,
          'table_name',t.name,
          'account_name',a.account_name,
          'covers',a.covers,
          'admitted_covers',a.admitted_covers,
          'status',a.status,
          'account_type',a.account_type,
          'financial_partition',a.financial_partition,
          'created_at',a.created_at,
          'updated_at',a.updated_at,
          'version',a.version,
          'balance',private.account_balance(a.id)
        )
        order by a.updated_at desc,a.id desc
      )
      from (
        select a.*
        from public.accounts a
        where a.venue_id=p_venue
          and a.floor_released_at is null
          and private.can_read_account(a.id)
        order by a.updated_at desc,a.id desc
        limit p_limit
      ) a
      left join public.tables t on t.id=a.table_id
    ),'[]'::jsonb),
    'viewer_user_id',v_actor
  );
end
$$;

revoke all on function public.get_accounts_center(uuid,integer)
from public,anon;
grant execute on function public.get_accounts_center(uuid,integer)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_accounts_center(uuid,integer)','authenticated')
on conflict do nothing;
