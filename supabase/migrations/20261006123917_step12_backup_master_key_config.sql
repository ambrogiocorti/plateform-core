
alter table private.continuity_worker_runtime_config
  add column if not exists backup_master_key text;
alter table private.continuity_worker_runtime_config
  drop constraint if exists continuity_worker_runtime_backup_master_key_len;
alter table private.continuity_worker_runtime_config
  add constraint continuity_worker_runtime_backup_master_key_len
  check (backup_master_key is null or length(backup_master_key) between 64 and 256);
