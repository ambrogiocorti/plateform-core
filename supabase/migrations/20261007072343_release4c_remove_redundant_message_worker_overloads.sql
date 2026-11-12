
drop function if exists public.claim_message_job(uuid);
drop function if exists public.fail_message_attempt(uuid,uuid,text);
drop function if exists public.finish_message_job(uuid,uuid,text,text,text);

delete from private.api_permission_manifest
where function_identity in (
  'public.claim_message_job(uuid)',
  'public.fail_message_attempt(uuid,uuid,text)',
  'public.finish_message_job(uuid,uuid,text,text,text)'
);
