
delete from private.api_permission_manifest
where function_identity='public.prepare_continuity_backup_snapshot(uuid,uuid,integer,text)'
  and api_role='service_role';

drop function if exists public.prepare_continuity_backup_snapshot(uuid,uuid,integer,text);
drop function if exists private.begin_continuity_backup_snapshot(uuid,uuid,text);

alter table private.continuity_worker_runtime_config
  drop constraint if exists continuity_worker_runtime_backup_master_key_len;
alter table private.continuity_worker_runtime_config
  drop column if exists backup_master_key;
