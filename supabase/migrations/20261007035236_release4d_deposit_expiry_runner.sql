create or replace function public.run_reservation_deposit_expiry(
  p_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_deposit public.reservation_deposits;
  v_reservation public.reservations;
  v_expired integer:=0;
  v_skipped integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 2000 then
    raise exception 'INVALID_LIMIT';
  end if;

  for v_deposit in
    select d.*
    from public.reservation_deposits d
    where d.status in ('PENDING','FAILED')
      and d.expires_at<=clock_timestamp()
    order by d.expires_at,d.id
    for update skip locked
    limit p_limit
  loop
    select * into v_reservation
    from public.reservations
    where id=v_deposit.reservation_id
    for update;

    if v_reservation.id is null then
      v_skipped:=v_skipped+1;
      continue;
    end if;

    if v_reservation.status<>'PENDING_DEPOSIT' then
      v_skipped:=v_skipped+1;
      continue;
    end if;

    if v_deposit.status='PENDING' then
      update public.reservation_deposits
      set status='EXPIRED'
      where id=v_deposit.id;
    end if;

    update public.reservations
    set status='EXPIRED'
    where id=v_reservation.id;

    update private.reservation_deposit_access
    set revoked_at=coalesce(revoked_at,clock_timestamp())
    where deposit_id=v_deposit.id;

    insert into public.notifications(
      venue_id,recipient_role,category,title,resource_type,resource_id
    ) values(
      v_reservation.venue_id,'HOST','RESERVATION',
      'Caparra scaduta','reservations',v_reservation.id
    );

    v_expired:=v_expired+1;
  end loop;

  return jsonb_build_object(
    'expired',v_expired,
    'skipped',v_skipped
  );
end
$$;

revoke all on function public.run_reservation_deposit_expiry(integer)
from public,anon,authenticated;
grant execute on function public.run_reservation_deposit_expiry(integer)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.run_reservation_deposit_expiry(integer)','service_role')
on conflict do nothing;

select cron.unschedule(jobid)
from cron.job
where jobname='plateform-reservation-deposit-expiry';

select cron.schedule(
  'plateform-reservation-deposit-expiry',
  '* * * * *',
  'select public.run_reservation_deposit_expiry(500);'
);