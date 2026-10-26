begin;
alter table public.print_jobs add column lease_owner uuid references public.staff_profiles(id);
alter table public.stations add column printer_id uuid;
alter table public.stations add column auto_print boolean not null default false;
alter table public.stations add foreign key(venue_id,printer_id) references public.print_devices(venue_id,id);
create function public.configure_station_printer(p_station uuid,p_printer uuid,p_auto boolean,p_version bigint) returns void language plpgsql security definer set search_path='' as $$
declare s public.stations;
begin select * into s from public.stations where id=p_station for update;if s.id is null then raise exception 'NOT_FOUND';end if;
  perform private.authorize(s.venue_id,array['ADMIN']::public.user_role[]);if s.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if p_printer is not null and not exists(select 1 from public.print_devices where id=p_printer and venue_id=s.venue_id and active) then raise exception 'INVALID_PRINT_DEVICE';end if;
  update public.stations set printer_id=p_printer,auto_print=p_auto where id=s.id;
end $$;
grant execute on function public.configure_station_printer(uuid,uuid,boolean,bigint) to authenticated;
create function private.receipt_snapshot(p_account uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('restaurant',r.name,'logo',r.branding->>'logo_url','venue',v.name,'address',v.address,'timezone',v.timezone,'at',now(),
    'account',a.account_name,'table',t.name,'document','DOCUMENTO NON FISCALE','balance',private.account_balance(a.id),
    'lines',coalesce((select jsonb_agg(jsonb_build_object('name',x.dish_name,'quantity',x.quantity,'unit_price_cents',x.unit_price_cents,'discount_cents',x.discount_cents,'total_cents',x.total_cents) order by x.dish_name) from
      (select i.id,i.dish_name,count(*) quantity,u.gross_cents unit_price_cents,sum(u.discount_cents) discount_cents,sum(u.gross_cents-u.discount_cents) total_cents
       from public.billing_units u join public.order_items i on i.id=u.order_item_id where u.account_id=a.id and u.voided_at is null group by i.id,i.dish_name,u.gross_cents) x),'[]'),
    'payments',coalesce((select jsonb_agg(jsonb_build_object('method',p.method,'amount_cents',p.amount_cents,'tip_cents',p.tip_cents) order by p.created_at) from public.payments p where p.account_id=a.id and p.status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')),'[]'))
  from public.accounts a join public.venues v on v.id=a.venue_id join public.tables t on t.id=a.table_id cross join public.restaurant_profile r where a.id=p_account
$$;
create function public.request_account_print(p_account uuid,p_device uuid,p_kind text,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.accounts; d public.print_devices; result jsonb; ref uuid;
begin
  select * into a from public.accounts where id=p_account for update;if a.id is null then raise exception 'NOT_FOUND';end if;
  perform private.authorize(a.venue_id,array['ADMIN','CASHIER','WAITER']::public.user_role[]);
  if private.current_role()='WAITER' and private.responsible_waiter(a.table_id) is distinct from private.effective_user_id() then raise exception 'RESPONSIBLE_WAITER_REQUIRED';end if;
  select * into d from public.print_devices where id=p_device and venue_id=a.venue_id and active;
  if d.id is null or not private.current_role()=any(d.allowed_roles) then raise exception 'PRINT_FORBIDDEN';end if;
  if p_kind is null or p_kind not in ('COURTESY','RECEIPT') then raise exception 'INVALID_PRINT_KIND';end if;
  result:=private.idempotency_begin('account_print',p_key,jsonb_build_object('account',p_account,'device',p_device,'kind',p_kind));if result is not null then return result;end if;
  if p_kind='RECEIPT' and ((private.account_balance(a.id)->>'remaining_cents')::bigint<>0 or (private.account_balance(a.id)->>'pending_cents')::bigint<>0) then raise exception 'ACCOUNT_NOT_SETTLED';end if;
  insert into public.print_jobs(venue_id,print_device_id,account_id,kind,payload,requested_by,idempotency_key) values(a.venue_id,d.id,a.id,p_kind,private.receipt_snapshot(a.id),private.effective_user_id(),p_key) returning id into ref;
  perform private.audit('PRINT_REQUESTED','print_jobs',ref,a.venue_id,null,jsonb_build_object('account_id',a.id,'status','QUEUED'));
  return private.idempotency_finish('account_print',p_key,jsonb_build_object('id',ref));
end $$;
grant execute on function public.request_account_print(uuid,uuid,text,uuid) to authenticated;
create function private.print_authorize(p_device uuid) returns public.print_devices language plpgsql security definer set search_path='' as $$
declare d public.print_devices;
begin select * into d from public.print_devices where id=p_device and active;if d.id is null then raise exception 'INVALID_PRINT_DEVICE';end if;
  perform private.authorize(d.venue_id,array['ADMIN','CASHIER','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[]);
  if not private.current_role()=any(d.allowed_roles) then raise exception 'PRINT_FORBIDDEN';end if;return d;end $$;
create function public.claim_print_job(p_job uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.print_jobs; device public.print_devices;
begin
  select * into job from public.print_jobs where id=p_job for update;if job.id is null then raise exception 'NOT_FOUND';end if;
  device:=private.print_authorize(job.print_device_id);
  if job.status<>'QUEUED' then raise exception 'PRINT_RECONCILIATION_REQUIRED';end if;
  update public.print_jobs set status='SENT',lease_owner=private.effective_user_id(),lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1 where id=job.id returning * into job;
  return jsonb_build_object('job',to_jsonb(job),'device',to_jsonb(device));
end $$;
grant execute on function public.claim_print_job(uuid) to authenticated;
create function public.finish_print_job(p_job uuid,p_lease uuid,p_success boolean,p_error text default null) returns void language plpgsql security definer set search_path='' as $$
declare job public.print_jobs;
begin select * into job from public.print_jobs where id=p_job for update;if job.id is null then raise exception 'NOT_FOUND';end if;perform private.print_authorize(job.print_device_id);
  if job.lease_token is distinct from p_lease or job.lease_owner is distinct from private.effective_user_id() or job.status not in ('SENT','SUCCESS','FAILED') then raise exception 'LEASE_CONFLICT';end if;
  if job.status in ('SUCCESS','FAILED') then return;end if;
  if p_success is null or (not p_success and p_error is null) then raise exception 'INVALID_PRINT_RESULT';end if;
  update public.print_jobs set status=case when p_success then 'SUCCESS'::public.print_job_status else 'FAILED'::public.print_job_status end,
    completed_at=case when p_success then now() end,last_error_code=case when p_success then null else 'PRINT_OUTCOME_UNKNOWN' end,lease_until=null where id=job.id;
  perform private.audit(case when p_success then 'PRINT_SUCCESS' else 'PRINT_FAILED' end,'print_jobs',job.id,job.venue_id,null,jsonb_build_object('status',case when p_success then 'SUCCESS' else 'FAILED' end));
end $$;
grant execute on function public.finish_print_job(uuid,uuid,boolean,text) to authenticated;
create function public.retry_print_job(p_job uuid,p_confirm_duplicate_risk boolean,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.print_jobs; ref uuid; result jsonb;
begin select * into job from public.print_jobs where id=p_job for update;if job.id is null then raise exception 'NOT_FOUND';end if;perform private.print_authorize(job.print_device_id);
  result:=private.idempotency_begin('print_retry',p_key,jsonb_build_object('job',p_job,'confirm',p_confirm_duplicate_risk));if result is not null then return result;end if;
  if p_confirm_duplicate_risk is distinct from true or job.status not in ('SENT','FAILED','SUCCESS') or job.lease_until>now() then raise exception 'PRINT_RECONCILIATION_REQUIRED';end if;
  insert into public.print_jobs(venue_id,print_device_id,account_id,order_id,kind,payload,requested_by,idempotency_key)
    values(job.venue_id,job.print_device_id,job.account_id,job.order_id,job.kind,job.payload||jsonb_build_object('reprint_of',job.id),private.effective_user_id(),p_key) returning id into ref;
  perform private.audit('PRINT_REPRINT_AUTHORIZED','print_jobs',ref,job.venue_id,null,jsonb_build_object('status','QUEUED'));
  return private.idempotency_finish('print_retry',p_key,jsonb_build_object('id',ref));
end $$;
grant execute on function public.retry_print_job(uuid,boolean,uuid) to authenticated;
-- Kitchen tickets are snapshots for the primary station only; observers never command production.
create function private.queue_kitchen_print() returns trigger language plpgsql security definer set search_path='' as $$
declare station public.stations; a public.accounts; key uuid; actor uuid;
begin
  select * into station from public.stations where id=new.station_id and auto_print and active;
  if station.printer_id is null then return new;end if;
  select a0.* into a from public.accounts a0 join public.orders o on o.account_id=a0.id where o.id=new.order_id;
  select created_by into actor from public.orders where id=new.order_id;
  if not exists(select 1 from public.staff_profiles where id=actor) then actor:=private.responsible_waiter(a.table_id);end if;
  if actor is null then return new;end if;
  key:=gen_random_uuid();
  insert into public.print_jobs(venue_id,print_device_id,account_id,order_id,kind,payload,requested_by,idempotency_key)
    values(new.venue_id,station.printer_id,a.id,new.order_id,'KITCHEN',jsonb_build_object('restaurant',(select name from public.restaurant_profile),'table',(select name from public.tables where id=a.table_id),'account',a.account_name,'at',now(),'document','COMANDA · NON FISCALE','lines',jsonb_build_array(jsonb_build_object('name',new.dish_name,'quantity',new.quantity,'step',(select step_number from public.order_steps where id=new.step_id),'removed',(select coalesce(jsonb_agg(ingredient_name),'[]') from public.order_item_removed_ingredients where order_item_id=new.id),'variants',(select coalesce(jsonb_agg(jsonb_build_object('group',group_name,'option',option_name)),'[]') from public.order_item_variants where order_item_id=new.id)))),actor,key);
  return new;
end $$;
-- Deferred execution includes the structured variant/removal rows created in the same transaction.
create constraint trigger kitchen_print after insert on public.order_items deferrable initially deferred for each row execute function private.queue_kitchen_print();
drop policy print_read on public.print_devices;
create policy print_read on public.print_devices for select to authenticated using(private.has_venue(venue_id) and (private.current_role()='ADMIN' or private.current_role()=any(allowed_roles)));
drop policy print_read on public.print_jobs;
create policy print_read on public.print_jobs for select to authenticated using(private.has_venue(venue_id) and exists(select 1 from public.print_devices d where d.id=print_device_id and (private.current_role()='ADMIN' or private.current_role()=any(d.allowed_roles))));
commit;
