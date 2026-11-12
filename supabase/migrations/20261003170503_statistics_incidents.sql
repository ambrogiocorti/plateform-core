begin;
create index journal_period on public.cash_journal(venue_id,created_at);
create function public.get_operational_statistics(p_venue uuid,p_start date,p_end date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare venues uuid[]; result jsonb;
begin perform private.authorize(p_venue,array['ADMIN','CASHIER']::public.user_role[],false);
  if p_start is null or p_end is null or p_end<p_start or p_end-p_start>365 then raise exception 'INVALID_FILTER';end if;
  if p_venue is null and private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED';end if;
  select array_agg(id) into venues from public.venues where active and private.has_venue(id) and (p_venue is null or id=p_venue);
  with movements as (select j.*,(j.created_at at time zone v.timezone)::date local_date from public.cash_journal j join public.venues v on v.id=j.venue_id where j.venue_id=any(venues) and j.created_at>=p_start::timestamp at time zone v.timezone and j.created_at<(p_end+1)::timestamp at time zone v.timezone)
  select jsonb_build_object('start',p_start,'end',p_end,
    'receipts_cents',coalesce((select sum(amount_cents) from movements where kind='RECEIPT'),0),
    'refunds_cents',coalesce((select -sum(amount_cents) from movements where kind='REFUND'),0),
    'reversals_cents',coalesce((select -sum(amount_cents) from movements where kind='REVERSAL'),0),
    'net_cents',coalesce((select sum(amount_cents) from movements),0),'tips_cents',coalesce((select sum(tip_cents) from movements),0),
    'daily',coalesce((select jsonb_agg(to_jsonb(x) order by local_date) from(select local_date,sum(amount_cents) amount_cents,sum(tip_cents) tip_cents from movements group by local_date)x),'[]'),
    'methods',coalesce((select jsonb_agg(to_jsonb(x) order by method) from(select method,sum(amount_cents) amount_cents,sum(tip_cents) tip_cents,count(*) entries from movements group by method)x),'[]'),
    'venues',coalesce((select jsonb_agg(to_jsonb(x) order by name) from(select v.name,v.id,sum(m.amount_cents) amount_cents,sum(m.tip_cents) tip_cents from movements m join public.venues v on v.id=m.venue_id group by v.name,v.id)x),'[]'),
    'products',coalesce((select jsonb_agg(to_jsonb(x) order by quantity desc,name) from(select i.dish_name name,count(*) quantity,sum(u.gross_cents-u.discount_cents) amount_cents from public.billing_units u join public.order_items i on i.id=u.order_item_id join public.orders o on o.id=i.order_id join public.venues v on v.id=u.venue_id where u.venue_id=any(venues) and u.voided_at is null and o.created_at>=p_start::timestamp at time zone v.timezone and o.created_at<(p_end+1)::timestamp at time zone v.timezone group by i.dish_name order by quantity desc limit 50)x),'[]'),
    'covers',coalesce((select sum(a.covers) from public.accounts a join public.venues v on v.id=a.venue_id where a.venue_id=any(venues) and a.created_at>=p_start::timestamp at time zone v.timezone and a.created_at<(p_end+1)::timestamp at time zone v.timezone),0),
    'preparation_seconds',(select round(avg(extract(epoch from i.ready_at-i.started_at))) from public.order_items i join public.orders o on o.id=i.order_id join public.venues v on v.id=i.venue_id where i.venue_id=any(venues) and i.ready_at>=p_start::timestamp at time zone v.timezone and i.ready_at<(p_end+1)::timestamp at time zone v.timezone and i.ready_at>=i.started_at),
    'reservations',(select count(*) from public.reservations where venue_id=any(venues) and service_date between p_start and p_end and status not in ('CANCELLED','NO_SHOW')))
  into result;
  return result;
end $$;
grant execute on function public.get_operational_statistics(uuid,date,date) to authenticated;
create function public.update_incident(p_id uuid,p_venue uuid,p_component text,p_severity public.incident_severity,p_title text,p_impact text,p_status text,p_detail text,p_version bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.incidents; ref uuid; result jsonb;
begin perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('incident',p_key,jsonb_build_object('id',p_id,'venue',p_venue,'component',p_component,'severity',p_severity,'title',p_title,'impact',p_impact,'status',p_status,'detail',p_detail,'version',p_version));if result is not null then return result;end if;
  if p_status is null or p_status not in ('OPEN','INVESTIGATING','MITIGATED','RESOLVED') or p_title is null or length(trim(p_title)) not between 3 and 160 or p_component is null or p_component not in ('DATABASE','AUTH','REALTIME','STORAGE','EDGE','PAYMENTS','PRINT','OFFLINE','BACKUP','APPLICATION') or p_impact is null or length(trim(p_impact))<3 or p_detail is null or length(trim(p_detail))<3 then raise exception 'INVALID_INCIDENT';end if;
  if p_id is null then
    if p_status<>'OPEN' then raise exception 'INVALID_TRANSITION';end if;
    insert into public.incidents(venue_id,component,severity,title,impact,owner_id) values(p_venue,p_component,p_severity,p_title,p_impact,private.effective_user_id()) returning id into ref;
  else
    select * into previous from public.incidents where id=p_id for update;if previous.id is null then raise exception 'NOT_FOUND';end if;if previous.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
    if previous.status='RESOLVED' then raise exception 'INCIDENT_ALREADY_RESOLVED';end if;
    update public.incidents set severity=p_severity,title=p_title,impact=p_impact,status=p_status,resolved_at=case when p_status='RESOLVED' then now() end,postmortem=case when p_status='RESOLVED' then p_detail else postmortem end where id=p_id;ref:=p_id;
  end if;
  insert into public.incident_events(incident_id,actor_id,action,detail) values(ref,private.effective_user_id(),p_status,p_detail);
  perform private.audit('INCIDENT_UPDATED','incidents',ref,p_venue,null,jsonb_build_object('status',p_status));
  return private.idempotency_finish('incident',p_key,jsonb_build_object('id',ref));
end $$;
grant execute on function public.update_incident(uuid,uuid,text,public.incident_severity,text,text,text,text,bigint,uuid) to authenticated;
create trigger incident_events_immutable before update or delete on public.incident_events for each row execute function private.immutable_record();
create trigger incident_events_no_truncate before truncate on public.incident_events for each statement execute function private.immutable_record();
commit;
