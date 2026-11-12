-- STEP 7 / §65 Piatti tornati indietro: return_order_item accetta piatti READY o SERVED, ma
-- l'interfaccia mostrava l'azione solo sui piatti READY ancora al Pass. Un piatto rimandato
-- indietro dal tavolo (il caso reale più frequente) era già SERVED e spariva dalla vista, quindi
-- non era possibile né RIFARLO né chiederne l'annullamento. Questa lettura elenca i piatti
-- serviti di recente su conti con tavolo non ancora liberato, solo a PASS e KITCHEN_ADMIN della
-- sede e solo se la funzione è attiva. Le regole restano in return_order_item (versione,
-- idempotenza, disponibilità per RIFARE, approvazione Admin per ANNULLARE, audit).

create or replace function public.get_returnable_items(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  perform private.authorize(p_venue,array['PASS','KITCHEN_ADMIN']::public.user_role[],false);
  if not coalesce((select returns_enabled from public.venue_settings where venue_id=p_venue),false) then
    return jsonb_build_object('enabled',false,'items','[]'::jsonb);
  end if;
  return jsonb_build_object(
    'enabled',true,
    'items',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',i.id,
          'version',i.version,
          'dish_name',i.dish_name,
          'quantity',i.quantity,
          'step_number',s.step_number,
          'table_name',coalesce(t.name,'Tavolo '||t.number::text),
          'account_name',a.account_name,
          'served_at',i.served_at
        ) order by i.served_at desc,i.id
      )
      from public.order_items i
      join public.orders o on o.id=i.order_id
      join public.accounts a on a.id=o.account_id
      join public.order_steps s on s.id=i.step_id
      left join public.tables t on t.id=a.table_id
      where i.venue_id=p_venue
        and i.status='SERVED'
        and a.floor_released_at is null
        and a.status<>'CLOSED'
        and i.served_at>=clock_timestamp()-interval '4 hours'
    ),'[]'::jsonb)
  );
end $$;

revoke all on function public.get_returnable_items(uuid) from public, anon;
grant execute on function public.get_returnable_items(uuid) to authenticated;
