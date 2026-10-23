-- STEP 8 / §112 Conflict Center: un ordine offline rifiutato (per esempio piatto esaurito o conto
-- modificato da un altro dispositivo) poteva solo essere annullato o segnato come verificato; per
-- correggerlo il cameriere doveva ricrearlo a mano. Questa RPC permette all'Admin della sede di
-- risolvere il conflitto inviando l'ordine corretto ("Modifica ordine") o senza i piatti tolti
-- ("Annulla item"), in una sola transazione: l'ordine passa da place_order con tutte le regole
-- (disponibilità, orari, stazione, stato del conto) e il conflitto si chiude solo se l'ordine è
-- stato creato. L'evento offline originale resta REJECTED: non è mai stato eseguito come inviato.

create or replace function public.resolve_order_conflict(
  p_conflict uuid,
  p_items jsonb,
  p_reason text,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  conflict_row public.sync_conflicts;
  event_row public.offline_sync_events;
  account_row public.accounts;
  result jsonb;
  order_ref uuid;
begin
  select * into conflict_row from public.sync_conflicts where id=p_conflict for update;
  if conflict_row.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(conflict_row.venue_id,array['ADMIN']::public.user_role[]);
  if p_key is null then raise exception 'INVALID_CONFLICT_RESOLUTION'; end if;
  result:=private.idempotency_begin('conflict_order_correction',p_key,
    jsonb_build_object('conflict',p_conflict,'items',p_items,'reason',p_reason));
  if result is not null then return result; end if;
  select * into event_row from public.offline_sync_events
    where id=conflict_row.sync_event_id and venue_id=conflict_row.venue_id;
  if conflict_row.status<>'OPEN' or event_row.id is null or event_row.operation<>'CREATE_ORDER'
    or p_reason is null or length(trim(p_reason))<3 then
    raise exception 'INVALID_CONFLICT_RESOLUTION';
  end if;
  select * into account_row from public.accounts
    where id=event_row.resource_id and venue_id=conflict_row.venue_id;
  if account_row.id is null then raise exception 'NOT_FOUND'; end if;
  order_ref:=private.place_order(account_row.id,p_items,'OFFLINE');
  update public.sync_conflicts
    set status='RESOLVED',
        resolution=jsonb_build_object('action','CORRECTED','reason',trim(p_reason),'order_id',order_ref,
          'requested_lines',jsonb_array_length(coalesce(event_row.payload->'items','[]'::jsonb)),
          'sent_lines',jsonb_array_length(p_items)),
        resolved_by=private.effective_user_id(),
        resolved_at=now()
    where id=conflict_row.id;
  perform private.audit('OFFLINE_CONFLICT_CORRECTED','sync_conflicts',conflict_row.id,conflict_row.venue_id,
    jsonb_build_object('status','OPEN','requested',event_row.payload->'items'),
    jsonb_build_object('status','RESOLVED','order_id',order_ref,'sent',p_items));
  return private.idempotency_finish('conflict_order_correction',p_key,
    jsonb_build_object('id',conflict_row.id,'order_id',order_ref));
end $$;

revoke all on function public.resolve_order_conflict(uuid,jsonb,text,uuid) from public, anon;
grant execute on function public.resolve_order_conflict(uuid,jsonb,text,uuid) to authenticated;
