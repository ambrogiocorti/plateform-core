begin;

create or replace function private.receipt_snapshot(p_account uuid)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'restaurant',r.name,
    'legal_name',r.legal_name,
    'logo',r.branding->>'logo_url',
    'venue',v.name,
    'address',v.address,
    'timezone',v.timezone,
    'at',now(),
    'account',a.account_name,
    'table',t.name,
    'document','DOCUMENTO NON FISCALE',
    'balance',private.account_balance(a.id),
    'lines',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name',x.dish_name,
          'quantity',x.quantity,
          'unit_price_cents',x.unit_price_cents,
          'discount_cents',x.discount_cents,
          'total_cents',x.total_cents
        )
        order by x.dish_name
      )
      from (
        select
          i.id,
          i.dish_name,
          count(*)::int quantity,
          u.gross_cents unit_price_cents,
          sum(u.discount_cents)::bigint discount_cents,
          sum(u.gross_cents-u.discount_cents)::bigint total_cents
        from public.billing_units u
        join public.order_items i on i.id=u.order_item_id
        where u.account_id=a.id
          and u.voided_at is null
        group by i.id,i.dish_name,u.gross_cents
      ) x
    ),'[]'::jsonb),
    'payments',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'method',x.method,
          'amount_cents',x.effective_amount_cents,
          'tip_cents',x.tip_cents
        )
        order by x.created_at
      )
      from (
        select
          p.method,
          greatest(
            p.amount_cents-coalesce((
              select sum(ref.amount_cents)
              from public.refunds ref
              where ref.original_payment_id=p.id
                and ref.status='COMPLETED'
            ),0),
            0
          )::bigint effective_amount_cents,
          p.tip_cents,
          p.created_at
        from public.payments p
        where p.account_id=a.id
          and p.status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
      ) x
      where x.effective_amount_cents>0 or x.tip_cents>0
    ),'[]'::jsonb),
    'refunds',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'method',p.method,
          'amount_cents',ref.amount_cents
        )
        order by ref.created_at
      )
      from public.refunds ref
      join public.payments p on p.id=ref.original_payment_id
      where p.account_id=a.id
        and ref.status='COMPLETED'
    ),'[]'::jsonb)
  )
  from public.accounts a
  join public.venues v on v.id=a.venue_id
  join public.tables t on t.id=a.table_id
  cross join public.restaurant_profile r
  where a.id=p_account
$$;

commit;
