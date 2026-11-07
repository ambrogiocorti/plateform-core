
create index if not exists offline_sync_events_authorization_fk_idx
on public.offline_sync_events(authorization_id);

create index if not exists offline_sync_events_device_fk_idx
on public.offline_sync_events(device_id);

create index if not exists sync_conflicts_resolved_by_fk_idx
on public.sync_conflicts(resolved_by);

create index if not exists sync_conflicts_venue_sync_event_fk_idx
on public.sync_conflicts(venue_id,sync_event_id);
