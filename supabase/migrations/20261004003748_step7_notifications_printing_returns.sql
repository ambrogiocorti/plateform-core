begin;

-- STEP 7: persistent notification center, role/event sound routing and printer/provider incidents.
create or replace function private.notification_rule(
  p_venue uuid,
  p_category text,
  p_recipient_role public.user_role default null,
  p_recipient_user uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  rules jsonb;
  target_role public.user_role:=p_recipient_role;
  role_prefix text;
begin
  if target_role is null and p_recipient_user is not null then
    select role into target_role from public.staff_profiles where id=p_recipient_user and active;
  end if;
  select sounds into rules from public.venue_settings where venue_id=p_venue;
  if rules is null then return null; end if;
  if target_role is not null then
    role_prefix:=target_role::text||'__';
    if rules ? (role_prefix||p_category) then return rules->(role_prefix||p_category); end if;
    if rules ? (role_prefix||'DEFAULT') then return rules->(role_prefix||'DEFAULT'); end if;
  end if;
  if rules ? p_category then return rules->p_category; end if;
  return rules->'DEFAULT';
end $$;

create or replace function private.notification_priority() returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare rule jsonb;
begin
  rule:=private.notification_rule(new.venue_id,new.category,new.recipient_role,new.recipient_user_id);
  if rule is not null and rule->>'priority' in ('INFO','WARNING','DEGRADED','INCIDENT','CRITICAL') then
    new.priority:=(rule->>'priority')::public.incident_severity;
  end if;
  return new;
end $$;

create trigger notification_touch_version
before update on public.notifications
for each row execute function private.touch_version();

create or replace function private.expire_notification_inbox(
  p_venue uuid,
  p_actor uuid,
  p_role public.user_role
) returns void
language sql
security definer
set search_path=''
as $$
  update public.notifications
     set status='EXPIRED'
   where venue_id=p_venue
     and status in ('NEW','ACKNOWLEDGED')
     and expires_at is not null
     and expires_at<=now()
     and (recipient_user_id=p_actor or (recipient_user_id is null and recipient_role=p_role))
$$;

create or replace function public.get_notification_summary(p_venue uuid) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid;
  role_name public.user_role;
begin
  actor:=private.authorize(
    p_venue,
    array['ADMIN','HOST','WAITER','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],
    false
  );
  if p_venue is null then raise exception 'VENUE_REQUIRED'; end if;
  role_name:=private.current_role();
  perform private.expire_notification_inbox(p_venue,actor,role_name);
  return jsonb_build_object(
    'new_count',(
      select count(*) from public.notifications n
       where n.venue_id=p_venue and n.status='NEW'
         and (n.recipient_user_id=actor or (n.recipient_user_id is null and n.recipient_role=role_name))
    ),
    'badge_count',(
      select count(*) from public.notifications n
       where n.venue_id=p_venue and n.status='NEW'
         and (n.recipient_user_id=actor or (n.recipient_user_id is null and n.recipient_role=role_name))
         and coalesce((private.notification_rule(n.venue_id,n.category,n.recipient_role,n.recipient_user_id)->>'enabled')::boolean,true)
         and coalesce((private.notification_rule(n.venue_id,n.category,n.recipient_role,n.recipient_user_id)->>'badge')::boolean,true)
    ),
    'active_count',(
      select count(*) from public.notifications n
       where n.venue_id=p_venue and n.status in ('NEW','ACKNOWLEDGED')
         and (n.recipient_user_id=actor or (n.recipient_user_id is null and n.recipient_role=role_name))
    ),
    'alerts',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at,x.id)
      from (
        select n.id,n.category,n.priority,n.created_at
          from public.notifications n
         where n.venue_id=p_venue and n.status='NEW'
           and (n.recipient_user_id=actor or (n.recipient_user_id is null and n.recipient_role=role_name))
         order by n.created_at desc,n.id desc
         limit 50
      ) x
    ),'[]'::jsonb),
    'rules',(select sounds from public.venue_settings where venue_id=p_venue)
  );
end $$;

grant execute on function public.get_notification_summary(uuid) to authenticated;

create function public.get_notification_center(p_venue uuid,p_limit int default 100) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid;
  role_name public.user_role;
begin
  actor:=private.authorize(
    p_venue,
    array['ADMIN','HOST','WAITER','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],
    false
  );
  if p_venue is null or p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_FILTER';
  end if;
  role_name:=private.current_role();
  perform private.expire_notification_inbox(p_venue,actor,role_name);
  return jsonb_build_object(
    'items',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id desc)
      from (
        select n.id,n.category,n.title,n.priority,n.status,n.created_at,n.acknowledged_at,
               n.resolved_at,n.expires_at,n.resource_type,n.resource_id,n.version
          from public.notifications n
         where n.venue_id=p_venue
           and n.status in ('NEW','ACKNOWLEDGED')
           and (n.recipient_user_id=actor or (n.recipient_user_id is null and n.recipient_role=role_name))
         order by n.created_at desc,n.id desc
         limit p_limit
      ) x
    ),'[]'::jsonb)
  );
end $$;
grant execute on function public.get_notification_center(uuid,int) to authenticated;

create or replace function public.transition_notification(
  p_notification uuid,
  p_status public.notification_status
) returns void
language plpgsql
security definer
set search_path=''
as $$
declare n public.notifications;
begin
  select * into n from public.notifications where id=p_notification for update;
  if n.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(
    n.venue_id,
    array['ADMIN','HOST','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS','WAITER']::public.user_role[]
  );
  if (n.recipient_user_id is not null and n.recipient_user_id<>private.effective_user_id())
     or (n.recipient_user_id is null and n.recipient_role<>private.current_role()) then
    raise exception 'NOTIFICATION_FORBIDDEN';
  end if;
  if n.expires_at is not null and n.expires_at<=now() and n.status in ('NEW','ACKNOWLEDGED') then
    update public.notifications set status='EXPIRED' where id=n.id;
    raise exception 'NOTIFICATION_EXPIRED';
  end if;
  if not ((n.status='NEW' and p_status='ACKNOWLEDGED') or (n.status='ACKNOWLEDGED' and p_status='RESOLVED')) then
    raise exception 'INVALID_TRANSITION';
  end if;
  update public.notifications
     set status=p_status,
         acknowledged_at=case when p_status='ACKNOWLEDGED' then now() else acknowledged_at end,
         resolved_at=case when p_status='RESOLVED' then now() end
   where id=n.id;
  perform private.audit(
    case when p_status='ACKNOWLEDGED' then 'NOTIFICATION_ACKNOWLEDGED' else 'NOTIFICATION_RESOLVED' end,
    'notifications',n.id,n.venue_id,
    jsonb_build_object('status',n.status),
    jsonb_build_object('status',p_status,'category',n.category,'resource_type',n.resource_type,'resource_id',n.resource_id)
  );
end $$;

grant execute on function public.transition_notification(uuid,public.notification_status) to authenticated;

create or replace function public.get_print_jobs(
  p_venue uuid,
  p_after_at timestamptz default null,
  p_after_id uuid default null,
  p_status text default null,
  p_limit int default 50
) returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare rows jsonb; more boolean;
begin
  perform private.authorize(
    p_venue,
    array['ADMIN','CASHIER','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],
    false
  );
  if p_venue is null or p_limit is null or p_limit not between 1 and 100
     or ((p_after_at is null)<>(p_after_id is null))
     or (p_status is not null and p_status not in ('QUEUED','SENT','SUCCESS','FAILED','CANCELLED')) then
    raise exception 'INVALID_FILTER';
  end if;
  with page as (
    select id,print_device_id,kind,status,created_at,payload
      from public.print_jobs
     where venue_id=p_venue
       and (p_status is null or status::text=p_status)
       and (p_after_at is null or (created_at,id)<(p_after_at,p_after_id))
     order by created_at desc,id desc
     limit p_limit+1
  )
  select coalesce((
    select jsonb_agg(to_jsonb(x) order by created_at desc,id desc)
      from (select * from page order by created_at desc,id desc limit p_limit) x
  ),'[]'::jsonb),(select count(*)>p_limit from page)
  into rows,more;
  return jsonb_build_object('items',rows,'has_more',more);
end $$;

grant execute on function public.get_print_jobs(uuid,timestamptz,uuid,text,int) to authenticated;

create function private.step7_print_job_notifications() returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare original uuid;
begin
  if new.status='FAILED' and old.status is distinct from new.status then
    insert into public.notifications(
      venue_id,recipient_role,category,title,resource_type,resource_id
    ) values(
      new.venue_id,'ADMIN','PRINTER_FAILURE','Stampante da verificare','print_jobs',new.id
    );
  elsif new.status='SUCCESS' and old.status is distinct from new.status then
    begin
      original:=nullif(new.payload->>'reprint_of','')::uuid;
    exception when invalid_text_representation then
      original:=null;
    end;
    update public.notifications
       set status='RESOLVED',resolved_at=coalesce(resolved_at,now())
     where venue_id=new.venue_id
       and category='PRINTER_FAILURE'
       and status in ('NEW','ACKNOWLEDGED')
       and resource_type='print_jobs'
       and resource_id in (new.id,coalesce(original,new.id));
  end if;
  return new;
end $$;
create trigger step7_print_job_notifications
after update of status on public.print_jobs
for each row execute function private.step7_print_job_notifications();

create function private.step7_provider_failure_notifications() returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.state='FAILED' and old.state is distinct from new.state then
    insert into public.notifications(
      venue_id,recipient_role,category,title,resource_type,resource_id
    ) values
      (new.venue_id,'ADMIN','PAYMENT_ANOMALY','Pagamento provider da riconciliare','provider_operations',new.id),
      (new.venue_id,'CASHIER','PAYMENT_ANOMALY','Pagamento provider da riconciliare','provider_operations',new.id);
  end if;
  return new;
end $$;
create trigger step7_provider_failure_notifications
after update of state on public.provider_operations
for each row execute function private.step7_provider_failure_notifications();

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_notification_center(uuid,integer)','authenticated')
on conflict do nothing;

commit;