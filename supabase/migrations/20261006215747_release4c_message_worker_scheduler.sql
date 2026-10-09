
create or replace function public.invoke_reservation_message_worker(
  p_max_jobs integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_token text;
  v_request_id bigint;
begin
  if p_max_jobs is null or p_max_jobs not between 1 and 50 then
    raise exception 'INVALID_MAX_JOBS';
  end if;

  select decrypted_secret
  into v_token
  from vault.decrypted_secrets
  where name='plateform_message_worker_token'
  order by created_at desc
  limit 1;

  if v_token is null or length(v_token)<32 then
    raise exception 'MESSAGE_WORKER_TOKEN_MISSING';
  end if;

  v_request_id:=net.http_post(
    url:='https://abdxvlykasqmknexxhjo.supabase.co/functions/v1/reservation-message-worker',
    body:=jsonb_build_object('max_jobs',p_max_jobs),
    params:='{}'::jsonb,
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-plateform-worker-token',v_token
    ),
    timeout_milliseconds:=10000
  );

  return jsonb_build_object(
    'queued',true,
    'request_id',v_request_id
  );
end
$$;

revoke all on function public.invoke_reservation_message_worker(integer)
from public,anon,authenticated;
grant execute on function public.invoke_reservation_message_worker(integer)
to service_role,postgres;

create or replace function public.run_reservation_messaging_tick()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_outbox jsonb;
  v_reminders jsonb;
  v_worker jsonb;
begin
  v_outbox:=public.run_reservation_message_outbox(200);

  v_reminders:=public.run_reservation_reminder_scheduler(
    clock_timestamp(),
    2,
    1000
  );

  v_worker:=public.invoke_reservation_message_worker(20);

  return jsonb_build_object(
    'outbox',v_outbox,
    'reminders',v_reminders,
    'worker',v_worker
  );
end
$$;

revoke all on function public.run_reservation_messaging_tick()
from public,anon,authenticated;
grant execute on function public.run_reservation_messaging_tick()
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.invoke_reservation_message_worker(integer)','service_role'),
  ('public.run_reservation_messaging_tick()','service_role')
on conflict do nothing;

do $$
begin
  if exists(
    select 1 from cron.job
    where jobname='plateform-reservation-messaging'
  ) then
    perform cron.unschedule('plateform-reservation-messaging');
  end if;
end
$$;

select cron.schedule(
  'plateform-reservation-messaging',
  '* * * * *',
  'select public.run_reservation_messaging_tick();'
);
