
create or replace function public.run_reservation_message_outbox(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_event private.reservation_message_outbox;
  v_setting public.message_provider_settings;
  v_created integer:=0;
  v_processed integer:=0;
  v_failed integer:=0;
  v_error text;
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'INVALID_LIMIT';
  end if;

  for v_event in
    select *
    from private.reservation_message_outbox o
    where o.processed_at is null
      and o.next_attempt_at<=clock_timestamp()
      and private.venue_feature_enabled(
        o.venue_id,
        'RESERVATION_MESSAGING'
      )
    order by o.created_at,o.id
    for update skip locked
    limit p_limit
  loop
    begin
      for v_setting in
        select *
        from public.message_provider_settings
        where venue_id=v_event.venue_id
          and enabled
          and private.message_channel_enabled(
            v_event.venue_id,
            channel
          )
        order by channel
      loop
        perform private.enqueue_reservation_message(
          v_event.reservation_id,
          'RESERVATION_CONFIRMATION',
          v_setting.channel,
          v_event.created_at,
          v_event.event_key||':'||lower(v_setting.channel),
          null
        );

        v_created:=v_created+1;
      end loop;

      update private.reservation_message_outbox
      set processed_at=clock_timestamp(),
          attempts=attempts+1,
          last_error_code=null
      where id=v_event.id;

      v_processed:=v_processed+1;
    exception when others then
      get stacked diagnostics v_error=message_text;

      update private.reservation_message_outbox
      set attempts=attempts+1,
          last_error_code=left(v_error,120),
          next_attempt_at=clock_timestamp()
            + make_interval(
                secs=>least(
                  3600,
                  greatest(30,30*(2^least(attempts,6))::integer)
                )
              )
      where id=v_event.id;

      v_failed:=v_failed+1;
    end;
  end loop;

  return jsonb_build_object(
    'processed_events',v_processed,
    'jobs_created_or_reused',v_created,
    'failed_events',v_failed
  );
end
$$;

create or replace function public.run_reservation_messaging_tick(
  p_outbox_limit integer default 200,
  p_reminder_horizon_minutes integer default 5,
  p_reminder_limit integer default 500,
  p_worker_jobs integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_outbox jsonb;
  v_reminders jsonb;
  v_worker jsonb:=jsonb_build_object('queued',false,'reason','NO_DUE_JOBS');
  v_due boolean;
begin
  if p_outbox_limit not between 1 and 500
     or p_reminder_horizon_minutes not between 0 and 60
     or p_reminder_limit not between 1 and 2000
     or p_worker_jobs not between 1 and 50
  then
    raise exception 'INVALID_MESSAGING_TICK_INPUT';
  end if;

  v_outbox:=public.run_reservation_message_outbox(p_outbox_limit);

  v_reminders:=public.run_reservation_reminder_scheduler(
    clock_timestamp(),
    p_reminder_horizon_minutes,
    p_reminder_limit
  );

  select exists(
    select 1
    from public.message_jobs j
    where (
      j.state='QUEUED'
      and j.next_attempt_at<=clock_timestamp()
      and j.scheduled_for<=clock_timestamp()
      and j.attempts<j.max_attempts
      and private.message_channel_enabled(j.venue_id,j.channel)
    )
    or (
      j.state='SENDING'
      and j.lease_until<clock_timestamp()
    )
  )
  into v_due;

  if v_due then
    v_worker:=public.invoke_reservation_message_worker(p_worker_jobs);
  end if;

  return jsonb_build_object(
    'outbox',v_outbox,
    'reminders',v_reminders,
    'worker',v_worker
  );
end
$$;

revoke all on function public.run_reservation_messaging_tick(integer,integer,integer,integer)
from public,anon,authenticated;
grant execute on function public.run_reservation_messaging_tick(integer,integer,integer,integer)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values (
  'public.run_reservation_messaging_tick(integer,integer,integer,integer)',
  'service_role'
)
on conflict do nothing;

select cron.schedule(
  'plateform-reservation-messaging',
  '* * * * *',
  'select public.run_reservation_messaging_tick(200,5,500,20);'
)
where not exists(
  select 1 from cron.job
  where jobname='plateform-reservation-messaging'
);
