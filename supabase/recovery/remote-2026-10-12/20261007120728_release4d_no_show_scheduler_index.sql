
create index if not exists reservations_no_show_candidates_idx
on public.reservations(venue_id,service_id,service_date,slot_time,id)
where status='RESERVED' and not walk_in;
