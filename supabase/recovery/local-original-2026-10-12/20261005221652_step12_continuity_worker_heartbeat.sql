begin;

create table private.continuity_worker_heartbeats (
  worker text primary key check(worker in ('BACKUP','RETENTION','RESTORE_TEST','RESTORE')),
  status text not null check(status in ('POLLING','WORKING','IDLE','READY','ERROR')),
  last_seen_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check(jsonb_typeof(details)='object' and octet_length(details::text)<=4096)
);
alter table private.continuity_worker_heartbeats enable row level security;
revoke all on private.continuity_worker_heartbeats from public,anon,authenticated;

create or replace function public.record_continuity_worker_heartbeat(
  p_worker text,
  p_status text,
  p_details jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare row private.continuity_worker_heartbeats;
begin
  if p_worker is null or p_worker not in ('BACKUP','RETENTION','RESTORE_TEST','RESTORE')
     or p_status is null or p_status not in ('POLLING','WORKING','IDLE','READY','ERROR')
     or jsonb_typeof(coalesce(p_details,'{}'::jsonb))<>'object'
     or octet_length(coalesce(p_details,'{}'::jsonb)::text)>4096 then
    raise exception 'INVALID_CONTINUITY_WORKER_HEARTBEAT';
  end if;
  insert into private.continuity_worker_heartbeats(worker,status,last_seen_at,details)
  values(p_worker,p_status,clock_timestamp(),coalesce(p_details,'{}'::jsonb))
  on conflict(worker) do update set
    status=excluded.status,
    last_seen_at=excluded.last_seen_at,
    details=excluded.details
  returning * into row;
  return jsonb_build_object('worker',row.worker,'status',row.status,'last_seen_at',row.last_seen_at);
end $$;
revoke all on function public.record_continuity_worker_heartbeat(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_continuity_worker_heartbeat(text,text,jsonb) to service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.record_continuity_worker_heartbeat(text,text,jsonb)','service_role')
on conflict do nothing;

commit;
