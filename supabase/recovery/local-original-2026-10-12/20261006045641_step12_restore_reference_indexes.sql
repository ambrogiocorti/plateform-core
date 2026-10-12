create index restore_jobs_backup_id_idx
  on public.restore_jobs(backup_id);

create index restore_jobs_pre_restore_backup_id_idx
  on public.restore_jobs(pre_restore_backup_id)
  where pre_restore_backup_id is not null;
