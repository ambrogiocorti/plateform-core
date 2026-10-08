create index restore_jobs_requested_by_idx
  on public.restore_jobs(requested_by);

create index restore_jobs_cutover_confirmed_by_idx
  on public.restore_jobs(cutover_confirmed_by)
  where cutover_confirmed_by is not null;
