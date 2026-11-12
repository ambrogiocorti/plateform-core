-- Safe release of an order conflict after cancelling its sole line.
-- A corrected order is sent only when at least one line remains.
CREATE OR REPLACE FUNCTION public.resolve_order_conflict(p_conflict uuid, p_items jsonb, p_reason text, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- A removed last line must not create an empty order. The event stays
  -- rejected, while the conflict is closed with an audited, idempotent decision.
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>100 then
    raise exception 'INVALID_CONFLICT_RESOLUTION';
  end if;
  if jsonb_array_length(p_items)=0 then
    update public.sync_conflicts
       set status='DISCARDED',
           resolution=jsonb_build_object('action','DISCARD_ITEM','reason',trim(p_reason),
             'requested_lines',jsonb_array_length(coalesce(event_row.payload->'items','[]'::jsonb)),
             'sent_lines',0),
           resolved_by=private.effective_user_id(),
           resolved_at=now()
     where id=conflict_row.id;
    perform private.audit('OFFLINE_CONFLICT_DISCARDED','sync_conflicts',conflict_row.id,
      conflict_row.venue_id,
      jsonb_build_object('status','OPEN','requested',event_row.payload->'items'),
      jsonb_build_object('status','DISCARDED','sent','[]'::jsonb));
    return private.idempotency_finish('conflict_order_correction',p_key,
      jsonb_build_object('id',conflict_row.id,'order_id',null));
  end if;
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
end $function$

