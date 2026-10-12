create index backup_metadata_requested_by_idx
  on public.backup_metadata(requested_by)
  where requested_by is not null;
