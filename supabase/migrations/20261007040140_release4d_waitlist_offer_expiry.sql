create or replace function public.run_waitlist_offer_expiry(
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_entry public.waitlist_entries;
  v_expired integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'INVALID_LIMIT';
  end if;

  for v_entry in
    select *
    from public.waitlist_entries
    where status='OFFERED'
      and offer_expires_at<=clock_timestamp()
    order by offer_expires_at,id
    for update skip locked
    limit p_limit
  loop
    update public.waitlist_entries
    set status='EXPIRED'
    where id=v_entry.id;

    update private.waitlist_offer_access
    set revoked_at=coalesce(revoked_at,clock_timestamp())
    where entry_id=v_entry.id;

    insert into public.notifications(
      venue_id,recipient_role,category,title,resource_type,resource_id
    ) values(
      v_entry.venue_id,'HOST','RESERVATION','Offerta waitlist scaduta','waitlist_entries',v_entry.id
    );

    v_expired:=v_expired+1;
  end loop;

  return jsonb_build_object('expired',v_expired);
end
$$;

revoke all on function public.run_waitlist_offer_expiry(integer)
from public,anon,authenticated;
grant execute on function public.run_waitlist_offer_expiry(integer)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.run_waitlist_offer_expiry(integer)','service_role')
on conflict do nothing;

select cron.unschedule(jobid)
from cron.job
where jobname='plateform-waitlist-offer-expiry';

select cron.schedule(
  'plateform-waitlist-offer-expiry',
  '* * * * *',
  'select public.run_waitlist_offer_expiry(1000);'
);