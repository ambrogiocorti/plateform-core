create or replace function private.public_booking_ready(p_venue uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $fn$
select private.installation_active()
and exists (
  select 1
  from public.restaurant_profile p
  where p.id
    and jsonb_typeof(p.public_content->'privacy_url')='string'
    and (p.public_content->>'privacy_url') ~* '^https://([a-z0-9-]+[.])+[a-z0-9-]{2,63}(:[0-9]{1,5})?(/[^[:space:]]*)?$'
)
and exists (
  select 1
  from public.venues v
  join public.venue_settings vs on vs.venue_id=v.id
  join public.services s on s.venue_id=v.id and s.active
  join public.service_booking_rules r on r.venue_id=v.id and r.service_id=s.id
  where v.id=p_venue and v.active and v.operational_status='OPEN'
    and vs.reservations_enabled and array_length(s.weekdays,1)>0
    and r.slot_interval_minutes>0
);
$fn$;
revoke all on function private.public_booking_ready(uuid) from public,anon,authenticated;
comment on function private.public_booking_ready(uuid) is 'Step 11: expose booking CTA only if operational booking rules and a configured HTTPS privacy notice both exist.';