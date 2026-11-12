
drop function if exists public.claim_message_job(uuid);
drop function if exists public.finish_message_send(uuid,uuid,text,text,text,text);
drop function if exists public.release_message_lease(uuid,uuid,text);
drop function if exists public.apply_message_delivery_event(text,text,text,text,text);
drop function if exists public.finish_message_job(uuid,uuid,text,text,text,text,boolean);

delete from private.api_permission_manifest
where function_identity in (
  'public.claim_message_job(uuid)',
  'public.finish_message_send(uuid,uuid,text,text,text,text)',
  'public.release_message_lease(uuid,uuid,text)',
  'public.apply_message_delivery_event(text,text,text,text,text)',
  'public.finish_message_job(uuid,uuid,text,text,text,text,boolean)'
);
