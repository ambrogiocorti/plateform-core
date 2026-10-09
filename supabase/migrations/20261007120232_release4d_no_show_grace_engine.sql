
create or replace function public.run_reservation_no_show_scheduler(
  p_now timestamptz default clock_timestamp(),
  p_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_row record;
  v_due_at timestamptz;
  v_processed integer:=0;
  v_suggested integer:=0;
  v_marked integer:=0;
begin
  if p_now is null or p_limit not between 1 and 1000 then
    raise exception 'INVALID_NO_SHOW_RUN';
  end if;

  for v_row in
    select
      r.id,
      r.venue_id,
      r.service_id,
      r.service_date,
      r.slot_time,
      r.party_size,
      br.no_show_mode,
      br.no_show_grace_minutes,
      ((r.service_date + r.slot_time) at time zone v.timezone)
        + make_interval(mins=>br.no_show_grace_minutes) as due_at
    from public.reservations r
    join public.venues v
      on v.id=r.venue_id
    join public.service_booking_rules br
      on br.service_id=r.service_id
     and br.venue_id=r.venue_id
    where r.status='RESERVED'
      and not r.walk_in
      and v.active
      and br.no_show_mode in (
        'NO_SHOW_SUGGESTED',
        'NO_SHOW_AUTOMATIC_AFTER_GRACE_PERIOD'
      )
      and (
        ((r.service_date + r.slot_time) at time zone v.timezone)
          + make_interval(mins=>br.no_show_grace_minutes)
      ) <= p_now
    order by due_at,r.id
    for update of r skip locked
    limit p_limit
  loop
    v_processed:=v_processed+1;
    v_due_at:=v_row.due_at;

    if v_row.no_show_mode='NO_SHOW_SUGGESTED' then
      if not exists(
        select 1
        from public.notifications n
        where n.resource_type='reservations'
          and n.resource_id=v_row.id
          and n.category='NO_SHOW_SUGGESTION'
      ) then
        insert into public.notifications(
          venue_id,
          recipient_role,
          category,
          title,
          resource_type,
          resource_id
        ) values(
          v_row.venue_id,
          'HOST',
          'NO_SHOW_SUGGESTION',
          'Possibile no-show da verificare',
          'reservations',
          v_row.id
        );

        perform private.audit(
          'RESERVATION_NO_SHOW_SUGGESTED',
          'reservations',
          v_row.id,
          v_row.venue_id,
          null,
          jsonb_build_object(
            'mode',v_row.no_show_mode,
            'grace_minutes',v_row.no_show_grace_minutes,
            'due_at',v_due_at
          )
        );

        v_suggested:=v_suggested+1;
      end if;

    elsif v_row.no_show_mode='NO_SHOW_AUTOMATIC_AFTER_GRACE_PERIOD' then
      update public.reservations
      set status='NO_SHOW'
      where id=v_row.id
        and status='RESERVED';

      if found then
        insert into public.notifications(
          venue_id,
          recipient_role,
          category,
          title,
          resource_type,
          resource_id
        ) values(
          v_row.venue_id,
          'HOST',
          'NO_SHOW_AUTOMATIC',
          'Prenotazione segnata no-show automaticamente',
          'reservations',
          v_row.id
        );

        perform private.audit(
          'RESERVATION_NO_SHOW_AUTOMATIC',
          'reservations',
          v_row.id,
          v_row.venue_id,
          null,
          jsonb_build_object(
            'mode',v_row.no_show_mode,
            'grace_minutes',v_row.no_show_grace_minutes,
            'due_at',v_due_at,
            'new_status','NO_SHOW'
          )
        );

        v_marked:=v_marked+1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'processed',v_processed,
    'suggested',v_suggested,
    'marked_no_show',v_marked,
    'evaluated_at',p_now
  );
end
$$;

revoke all on function public.run_reservation_no_show_scheduler(timestamptz,integer)
from public,anon,authenticated;
grant execute on function public.run_reservation_no_show_scheduler(timestamptz,integer)
to service_role,postgres;

create or replace function public.correct_reservation_no_show(
  p_reservation uuid,
  p_target_status public.reservation_status,
  p_version bigint,
  p_reason text,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_row public.reservations;
  v_result jsonb;
  v_capacity jsonb;
  v_members uuid[];
begin
  if p_reservation is null
     or p_target_status not in ('RESERVED','ARRIVED')
     or p_version is null
     or p_key is null
     or p_reason is null
     or length(trim(p_reason)) not between 3 and 1000
  then
    raise exception 'INVALID_NO_SHOW_CORRECTION';
  end if;

  perform private.lock_floor(
    (select venue_id from public.reservations where id=p_reservation)
  );

  select * into v_row
  from public.reservations
  where id=p_reservation
  for update;

  if v_row.id is null then
    raise exception 'NOT_FOUND';
  end if;

  perform private.authorize(
    v_row.venue_id,
    array['ADMIN','HOST']::public.user_role[]
  );

  if not v_row.walk_in then
    perform private.require_booking_enabled(v_row.venue_id);
  end if;

  if v_row.status<>'NO_SHOW' then
    raise exception 'RESERVATION_NOT_NO_SHOW';
  end if;

  if v_row.version is distinct from p_version then
    raise exception 'VERSION_CONFLICT' using errcode='40001';
  end if;

  v_result:=private.idempotency_begin(
    'reservation_no_show_correction',
    p_key,
    jsonb_build_object(
      'reservation',p_reservation,
      'target_status',p_target_status,
      'version',p_version,
      'reason',trim(p_reason)
    )
  );
  if v_result is not null then
    return v_result;
  end if;

  v_capacity:=private.booking_capacity_snapshot(
    v_row.service_id,
    v_row.service_date,
    v_row.slot_time
  );

  if not coalesce((v_capacity->>'available')::boolean,false)
     or coalesce((v_capacity->>'available_covers')::integer,0)<v_row.party_size
     or coalesce((v_capacity->>'available_arrivals')::integer,0)<1
  then
    raise exception 'BOOKING_CAPACITY_REACHED' using errcode='40001';
  end if;

  if p_target_status='ARRIVED' and v_row.table_id is not null then
    v_members:=private.table_group(v_row.table_id);
    perform 1
    from public.tables
    where id=any(v_members)
    order by id
    for update;
  end if;

  update public.reservations
  set status=p_target_status,
      arrived_at=case
        when p_target_status='ARRIVED' then coalesce(arrived_at,clock_timestamp())
        else arrived_at
      end
  where id=v_row.id
  returning * into v_row;

  if p_target_status='ARRIVED' and v_row.table_id is not null then
    update public.tables
    set technical_status='ARRIVING'
    where id=any(v_members);
  end if;

  perform private.audit(
    'RESERVATION_NO_SHOW_CORRECTED',
    'reservations',
    v_row.id,
    v_row.venue_id,
    jsonb_build_object('status','NO_SHOW'),
    jsonb_build_object(
      'status',v_row.status,
      'reason',trim(p_reason)
    )
  );

  v_result:=jsonb_build_object(
    'reservation_id',v_row.id,
    'status',v_row.status,
    'version',v_row.version
  );

  return private.idempotency_finish(
    'reservation_no_show_correction',
    p_key,
    v_result
  );
end
$$;

revoke all on function public.correct_reservation_no_show(uuid,public.reservation_status,bigint,text,uuid)
from public,anon;
grant execute on function public.correct_reservation_no_show(uuid,public.reservation_status,bigint,text,uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values
  ('public.run_reservation_no_show_scheduler(timestamp with time zone,integer)','service_role'),
  ('public.correct_reservation_no_show(uuid,public.reservation_status,bigint,text,uuid)','authenticated')
on conflict do nothing;

select cron.schedule(
  'plateform-reservation-no-show',
  '* * * * *',
  'select public.run_reservation_no_show_scheduler(clock_timestamp(),200);'
)
where not exists(
  select 1
  from cron.job
  where jobname='plateform-reservation-no-show'
);

insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_NO_SHOW_GRACE_PERIOD',
  'REGRESSION',
  true,
  'No-show engine never marks before grace; SUGGESTED creates one Host notification after grace; AUTOMATIC transitions RESERVED to NO_SHOW server-side with audit and correction path.'
)
on conflict(key) do nothing;
