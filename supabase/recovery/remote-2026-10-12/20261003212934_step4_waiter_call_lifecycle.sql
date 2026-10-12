begin;

alter table public.waiter_calls
  add column response_time interval generated always as (
    case when accepted_at is null then null else accepted_at - created_at end
  ) stored;

alter table public.waiter_calls
  add constraint waiter_call_timeline check (
    (accepted_at is null or accepted_at >= created_at)
    and (completed_at is null or (accepted_at is not null and completed_at >= accepted_at))
  );

create or replace function public.transition_waiter_call(p_call uuid,p_complete boolean) returns void
language plpgsql security definer set search_path='' as $$
declare c public.waiter_calls;
begin
  select * into c from public.waiter_calls where id=p_call for update;
  if c.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(c.venue_id,array['WAITER']::public.user_role[]);
  if c.assigned_waiter_id is distinct from private.effective_user_id() then raise exception 'CALL_NOT_ASSIGNED'; end if;
  if (p_complete and c.status<>'ACCEPTED') or (not p_complete and c.status<>'NEW') then raise exception 'INVALID_TRANSITION'; end if;

  update public.waiter_calls
     set status=case when p_complete then 'COMPLETED' else 'ACCEPTED' end,
         accepted_at=case when not p_complete then clock_timestamp() else accepted_at end,
         completed_at=case when p_complete then clock_timestamp() end
   where id=c.id;

  update public.notifications
     set status=case
           when p_complete then 'RESOLVED'::public.notification_status
           when status='NEW' then 'ACKNOWLEDGED'::public.notification_status
           else status
         end,
         acknowledged_at=case
           when acknowledged_at is null then clock_timestamp()
           else acknowledged_at
         end,
         resolved_at=case
           when p_complete and resolved_at is null then clock_timestamp()
           else resolved_at
         end
   where resource_type='waiter_calls' and resource_id=c.id and status<>'EXPIRED';
end $$;

notify pgrst,'reload schema';
commit;