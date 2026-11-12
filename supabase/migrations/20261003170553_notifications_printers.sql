begin;
-- These invoker RPCs retain table RLS; the helper returns identity after checking session and scope.
grant execute on function private.authorize(uuid,public.user_role[],boolean) to authenticated;
create function public.get_notification_summary(p_venue uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
  perform private.authorize(p_venue,array['ADMIN','HOST','WAITER','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],false);
  if p_venue is null then raise exception 'VENUE_REQUIRED';end if;
  return jsonb_build_object(
    'new_count',(select count(*) from public.notifications where venue_id=p_venue and status='NEW'),
    'badge_count',(select count(*) from public.notifications n join public.venue_settings s on s.venue_id=n.venue_id where n.venue_id=p_venue and n.status='NEW' and coalesce((coalesce(s.sounds->n.category,s.sounds->'DEFAULT')->>'enabled')::boolean,true) and coalesce((coalesce(s.sounds->n.category,s.sounds->'DEFAULT')->>'badge')::boolean,true)),
    'active_count',(select count(*) from public.notifications where venue_id=p_venue and status in ('NEW','ACKNOWLEDGED')),
    'alerts',coalesce((select jsonb_agg(to_jsonb(n) order by created_at,id) from
      (select id,category,priority,created_at from public.notifications where venue_id=p_venue and status='NEW' order by created_at desc,id desc limit 50) n),'[]'),
    'rules',(select sounds from public.venue_settings where venue_id=p_venue)
  );
end $$;
grant execute on function public.get_notification_summary(uuid) to authenticated;
create function private.validate_notification_rules() returns trigger language plpgsql set search_path='' as $$
declare entry record;
begin
  if jsonb_typeof(new.sounds)<>'object' or pg_column_size(new.sounds)>32768 then raise exception 'INVALID_NOTIFICATION_RULES';end if;
  for entry in select key,value from jsonb_each(new.sounds) loop
    if entry.key !~ '^[A-Z_]{1,60}$' or jsonb_typeof(entry.value)<>'object' or entry.value-array['sound','priority','enabled','badge']<>'{}'
      or not entry.value ?& array['sound','priority','enabled','badge'] or entry.value->>'sound' not in ('OFF','GENTLE','DOUBLE','URGENT')
      or jsonb_typeof(entry.value->'sound')<>'string' or jsonb_typeof(entry.value->'priority')<>'string' or entry.value->>'priority' not in ('INFO','WARNING','DEGRADED','INCIDENT','CRITICAL') or jsonb_typeof(entry.value->'enabled')<>'boolean' or jsonb_typeof(entry.value->'badge')<>'boolean'
      then raise exception 'INVALID_NOTIFICATION_RULES';end if;
  end loop;
  return new;
end $$;
create trigger notification_rules_valid before insert or update of sounds on public.venue_settings for each row execute function private.validate_notification_rules();
create function private.notification_priority() returns trigger language plpgsql security definer set search_path='' as $$
declare rule jsonb;
begin
  select coalesce(sounds->new.category,sounds->'DEFAULT') into rule from public.venue_settings where venue_id=new.venue_id;
  if rule is not null and rule->>'priority' in ('INFO','WARNING','DEGRADED','INCIDENT','CRITICAL') then new.priority:=(rule->>'priority')::public.incident_severity;end if;
  return new;
end $$;
create trigger apply_notification_priority before insert on public.notifications for each row execute function private.notification_priority();

alter table public.print_devices add column version bigint not null default 1;
alter table public.print_devices add column updated_at timestamptz not null default now();
create trigger touch_version before update on public.print_devices for each row execute function private.touch_version();
create function private.validate_print_device() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if length(trim(new.name)) not between 1 and 160 or cardinality(new.allowed_roles)=0 or array_position(new.allowed_roles,null) is not null
    or not new.allowed_roles<@array['ADMIN','CASHIER','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[] then raise exception 'INVALID_PRINT_DEVICE';end if;
  if (new.driver='BROWSER' and new.endpoint is not null) or (new.driver='EPOS' and (new.endpoint is null or new.endpoint !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/cgi-bin/epos/service[.]cgi([?][a-zA-Z0-9_=&%.-]+)?$'))
    or (new.driver='BRIDGE' and (new.endpoint is null or new.endpoint !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/v1/print$')) then raise exception 'INVALID_PRINT_ENDPOINT';end if;
  if tg_op='UPDATE' and old.active and not new.active and (exists(select 1 from public.stations where printer_id=new.id and active)
    or exists(select 1 from public.cash_registers where printer_id=new.id and active) or exists(select 1 from public.print_jobs where print_device_id=new.id and status in ('QUEUED','SENT')))
    then raise exception 'PRINT_DEVICE_IN_USE';end if;
  return new;
end $$;
create trigger print_device_valid before insert or update on public.print_devices for each row execute function private.validate_print_device();
create function public.save_print_device(p_id uuid,p_venue uuid,p_version bigint,p_name text,p_driver text,p_endpoint text,p_roles public.user_role[],p_active boolean,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('print_device',p_key,jsonb_build_object('id',p_id,'venue',p_venue,'version',p_version,'name',p_name,'driver',p_driver,'endpoint',p_endpoint,'roles',p_roles,'active',p_active));if result is not null then return result;end if;
  result:=public.save_configuration('print_devices',p_venue,p_id,jsonb_build_object('name',p_name,'driver',p_driver,'endpoint',p_endpoint,'allowed_roles',p_roles,'active',p_active),p_version);
  return private.idempotency_finish('print_device',p_key,jsonb_build_object('id',result->'id','version',result->'version'));
end $$;
grant execute on function public.save_print_device(uuid,uuid,bigint,text,text,text,public.user_role[],boolean,uuid) to authenticated;
create function public.get_print_jobs(p_venue uuid,p_after_at timestamptz default null,p_after_id uuid default null,p_status text default null,p_limit int default 50) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare rows jsonb; more boolean;
begin
  perform private.authorize(p_venue,array['ADMIN','CASHIER','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],false);
  if p_venue is null or p_limit is null or p_limit not between 1 and 100 or ((p_after_at is null)<>(p_after_id is null)) or (p_status is not null and p_status not in ('QUEUED','SENT','SUCCESS','FAILED','CANCELLED')) then raise exception 'INVALID_FILTER';end if;
  with page as (select id,kind,status,created_at,payload from public.print_jobs where venue_id=p_venue and (p_status is null or status::text=p_status)
    and (p_after_at is null or (created_at,id)<(p_after_at,p_after_id)) order by created_at desc,id desc limit p_limit+1)
  select coalesce((select jsonb_agg(to_jsonb(x) order by created_at desc,id desc) from(select * from page order by created_at desc,id desc limit p_limit)x),'[]'),(select count(*)>p_limit from page) into rows,more;
  return jsonb_build_object('items',rows,'has_more',more);
end $$;
grant execute on function public.get_print_jobs(uuid,timestamptz,uuid,text,int) to authenticated;
create index print_job_cursor on public.print_jobs(venue_id,created_at desc,id desc);
create function public.cancel_print_job(p_job uuid) returns void language plpgsql security definer set search_path='' as $$
declare job public.print_jobs;
begin
  select * into job from public.print_jobs where id=p_job for update;
  if job.id is null then raise exception 'NOT_FOUND';end if;
  perform private.print_authorize(job.print_device_id);
  if job.status='CANCELLED' then return;end if;
  if job.status<>'QUEUED' then raise exception 'PRINT_RECONCILIATION_REQUIRED';end if;
  update public.print_jobs set status='CANCELLED' where id=job.id;
  perform private.audit('PRINT_JOB_CANCELLED','print_jobs',job.id,job.venue_id,null,jsonb_build_object('status','CANCELLED'));
end $$;
grant execute on function public.cancel_print_job(uuid) to authenticated;
commit;
