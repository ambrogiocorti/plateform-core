-- ADR-0001: status of the venue hubs for the "Hub di sede" page. Venue
-- administrators see the hubs of their venue, never the secret digest.
begin;

create function public.get_venue_hubs(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.authorize(p_venue, array['ADMIN']::public.user_role[], false);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'hub_id', h.hub_id,
      'generation', h.generation,
      'applied_seq', h.applied_seq,
      'last_ingest_at', h.last_ingest_at,
      'created_at', h.created_at,
      'revoked_at', h.revoked_at,
      'quarantined', (select count(*) from private.venue_hub_quarantine q where q.hub_id = h.hub_id)
    ) order by h.created_at)
    from private.venue_hubs h
    where h.venue_id = p_venue
  ), '[]'::jsonb);
end
$$;
revoke all on function public.get_venue_hubs(uuid) from public, anon;
grant execute on function public.get_venue_hubs(uuid) to authenticated;

commit;
