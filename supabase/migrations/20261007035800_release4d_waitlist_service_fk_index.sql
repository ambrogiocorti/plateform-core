create index if not exists waitlist_entries_service_fk_idx
on public.waitlist_entries(service_id,service_date,status,created_at,id);