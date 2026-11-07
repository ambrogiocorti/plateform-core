
begin;

alter table private.continuity_rehearsal_blob enable row level security;
alter table private.continuity_rehearsal_key enable row level security;
alter table private.continuity_rehearsal_snapshot_manifest enable row level security;
alter table private.continuity_rehearsal_snapshot_rows enable row level security;
alter table private.continuity_rehearsal_snapshot_tables enable row level security;
alter table private.continuity_rehearsal_transfer_chunks enable row level security;
alter table private.continuity_rehearsal_transfer_key enable row level security;

revoke all on private.continuity_rehearsal_blob from public,anon,authenticated;
revoke all on private.continuity_rehearsal_key from public,anon,authenticated;
revoke all on private.continuity_rehearsal_snapshot_manifest from public,anon,authenticated;
revoke all on private.continuity_rehearsal_snapshot_rows from public,anon,authenticated;
revoke all on private.continuity_rehearsal_snapshot_tables from public,anon,authenticated;
revoke all on private.continuity_rehearsal_transfer_chunks from public,anon,authenticated;
revoke all on private.continuity_rehearsal_transfer_key from public,anon,authenticated;

commit;
