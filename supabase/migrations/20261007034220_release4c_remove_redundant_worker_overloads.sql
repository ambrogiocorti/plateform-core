delete from private.api_permission_manifest
where (function_identity,api_role) in (
  ('public.claim_message_job(uuid)','service_role'),
  ('public.finish_message_job(uuid,uuid,text,text,text,text)','service_role'),
  ('public.release_message_job_lease(uuid,uuid,text)','service_role')
);

drop function if exists public.claim_message_job(uuid);
drop function if exists public.finish_message_job(uuid,uuid,text,text,text,text);
drop function if exists public.release_message_job_lease(uuid,uuid,text);
drop function if exists private.message_retry_delay_seconds(public.message_jobs);