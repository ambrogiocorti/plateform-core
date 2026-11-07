CREATE OR REPLACE FUNCTION public.get_account_workspace(p_account uuid, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
  result:=private.original_account_workspace(p_account,p_before_at,p_before_id,p_limit);
  return result||(
    with page as (
      select o.id,o.created_at,o.status,o.version
      from public.orders o
      where (
        o.account_id=p_account
        or exists(
          select 1
          from public.order_items i
          join public.billing_units u on u.order_item_id=i.id
          where i.order_id=o.id
            and u.account_id=p_account
            and u.voided_at is null
        )
      )
        and (p_before_at is null or (o.created_at,o.id)<(p_before_at,p_before_id))
      order by o.created_at desc,o.id desc
      limit p_limit+1
    )
    select jsonb_build_object(
      'orders',coalesce((
        select jsonb_agg(
          to_jsonb(row)||jsonb_build_object(
            'items',coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'id',i.id,
                  'dish_name',i.dish_name,
                  'quantity',case
                    when i.status='CANCELLED' then i.quantity
                    else (
                      select count(*)
                      from public.billing_units u
                      where u.order_item_id=i.id
                        and u.account_id=p_account
                        and u.voided_at is null
                    )
                  end,
                  'unit_price_cents',i.unit_price_cents,
                  'status',i.status,
                  'version',i.version
                )
                order by i.id
              )
              from public.order_items i
              where i.order_id=row.id
                and (
                  exists(
                    select 1
                    from public.billing_units u
                    where u.order_item_id=i.id
                      and u.account_id=p_account
                      and u.voided_at is null
                  )
                  or (
                    i.status='CANCELLED'
                    and exists(
                      select 1 from public.orders
                      where id=i.order_id and account_id=p_account
                    )
                  )
                )
            ),'[]'::jsonb)
          )
          order by row.created_at desc,row.id desc
        )
        from (
          select * from page
          order by created_at desc,id desc
          limit p_limit
        ) row
      ),'[]'::jsonb),
      'has_more',(select count(*)>p_limit from page)
    )
  );
end
$function$
