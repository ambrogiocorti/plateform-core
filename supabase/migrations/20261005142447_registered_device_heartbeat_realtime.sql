drop trigger if exists realtime_invalidation on public.registered_devices;

create trigger realtime_invalidation
after insert or delete or update of user_id, venue_id, revoked_at
on public.registered_devices
for each row
execute function private.signal_change();