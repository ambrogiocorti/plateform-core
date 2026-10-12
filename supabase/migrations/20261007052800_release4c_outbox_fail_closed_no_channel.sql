
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
  v_channel_count integer;
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
      v_channel_count:=0;

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
        v_channel_count:=v_channel_count+1;

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

      if v_channel_count=0 then
        raise exception 'NO_ACTIVE_MESSAGE_CHANNEL';
      end if;

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

revoke all on function public.run_reservation_message_outbox(integer)
from public,anon,authenticated;
grant execute on function public.run_reservation_message_outbox(integer)
to service_role,postgres;
