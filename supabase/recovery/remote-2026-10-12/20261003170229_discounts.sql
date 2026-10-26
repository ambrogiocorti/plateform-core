begin;
create table public.discount_requests (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), account_id uuid not null,
  kind text not null check(kind in ('FIXED','PERCENT','ITEM_COMPLIMENTARY','ACCOUNT_COMPLIMENTARY')), value bigint not null,
  items jsonb not null default '[]', reason text not null check(length(trim(reason)) between 3 and 2000),
  requested_by uuid not null references public.staff_profiles(id), status text not null default 'PENDING' check(status in ('PENDING','APPLIED','REJECTED')),
  quoted_amount_cents bigint not null, account_version bigint not null, discount_id uuid references public.discounts(id),
  resolved_by uuid references public.staff_profiles(id), resolved_at timestamptz, decision_reason text,
  created_at timestamptz not null default now(), foreign key(venue_id,account_id) references public.accounts(venue_id,id)
);
alter table public.discount_requests enable row level security;
revoke all on public.discount_requests from public,anon,authenticated;
grant select on public.discount_requests to authenticated;
create policy discount_request_read on public.discount_requests for select to authenticated using(private.has_venue(venue_id) and private.is_role(array['ADMIN','CASHIER']::public.user_role[]));
create trigger audit_change after insert or update on public.discount_requests for each row execute function private.audit_row();
create function private.guard_discount_request() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op<>'UPDATE' or old.status<>'PENDING' or (to_jsonb(new)-array['status','discount_id','resolved_by','resolved_at','decision_reason']) is distinct from (to_jsonb(old)-array['status','discount_id','resolved_by','resolved_at','decision_reason']) then raise exception 'IMMUTABLE_RECORD'; end if;
  return new;
end $$;
create trigger guard_discount_request before update or delete on public.discount_requests for each row execute function private.guard_discount_request();
create trigger immutable_discount_requests_truncate before truncate on public.discount_requests for each statement execute function private.immutable_record();
create trigger immutable_discount before update or delete on public.discounts for each row execute function private.immutable_record();
create trigger immutable_discount_truncate before truncate on public.discounts for each statement execute function private.immutable_record();

create function private.discount_quote(p_account uuid,p_kind text,p_value bigint,p_items jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare account public.accounts; balance jsonb; amount bigint; units uuid[]; selection jsonb; requested_quantity integer; policy text;
begin
  select * into account from public.accounts where id=p_account;
  if account.id is null or account.status='CLOSED' then raise exception 'ACCOUNT_CLOSED'; end if;
  if p_kind is null or p_kind not in ('FIXED','PERCENT','ITEM_COMPLIMENTARY','ACCOUNT_COMPLIMENTARY') or p_value is null or p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'INVALID_DISCOUNT'; end if;
  select case when p_kind in ('FIXED','PERCENT') then discount_policy else complimentary_policy end into policy from public.venue_settings where venue_id=account.venue_id;
  if policy='DISABLED' then raise exception 'DISCOUNTS_DISABLED'; end if;
  balance:=private.account_balance(account.id);
  if (balance->>'pending_cents')::bigint>0 then raise exception 'PENDING_PAYMENT_RECONCILIATION_REQUIRED'; end if;
  if p_kind='ITEM_COMPLIMENTARY' then
    if jsonb_array_length(p_items)<>1 or p_value<>0 then raise exception 'INVALID_DISCOUNT'; end if;
    selection:=p_items->0;
    if jsonb_typeof(selection)<>'object' or selection-array['item_id','quantity']<>'{}'::jsonb or jsonb_typeof(selection->'quantity') is distinct from 'number' or (selection->>'quantity') !~ '^[1-9][0-9]{0,2}$' then raise exception 'INVALID_ALLOCATION_ITEM'; end if;
    requested_quantity:=(selection->>'quantity')::integer;
    select array_agg(id),sum(available_cents) into units,amount from (
      select id,available_cents from private.billing_balance(account.id) where order_item_id=(selection->>'item_id')::uuid and paid_cents=0 and pending_cents=0 and available_cents>0 order by unit_number,id limit requested_quantity
    ) chosen;
    if requested_quantity is null or coalesce(array_length(units,1),0)<>requested_quantity then raise exception 'SETTLED_ITEM_REQUIRES_CORRECTION'; end if;
  else
    if jsonb_array_length(p_items)<>0 then raise exception 'INVALID_DISCOUNT'; end if;
    if p_kind='FIXED' then amount:=p_value;
    elsif p_kind='PERCENT' then
      if p_value not between 1 and 10000 then raise exception 'INVALID_DISCOUNT'; end if;
      amount:=floor(((balance->>'total_cents')::numeric*p_value+5000)/10000)::bigint;
    else
      if p_value<>0 then raise exception 'INVALID_DISCOUNT'; end if;
      amount:=(balance->>'available_cents')::bigint;
    end if;
  end if;
  if amount is null or amount<=0 or amount>(balance->>'available_cents')::bigint then raise exception 'DISCOUNT_EXCEEDS_UNPAID'; end if;
  return jsonb_build_object('account_id',account.id,'version',account.version,'kind',p_kind,'amount_cents',amount,'units',units,'policy',policy,'balance',balance);
end $$;

create function public.preview_discount(p_account uuid,p_kind text,p_value bigint,p_items jsonb default '[]') returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize((select venue_id from public.accounts where id=p_account),array['ADMIN','CASHIER']::public.user_role[],false);
  if not private.can_read_account(p_account) then raise exception 'FORBIDDEN'; end if;
  return private.discount_quote(p_account,p_kind,p_value,p_items)-'units';
end $$;

create function private.apply_discount_request(p_request uuid,p_quote jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare request public.discount_requests; discount_ref uuid; units uuid[];
begin
  select * into request from public.discount_requests where id=p_request for update;
  insert into public.discounts(venue_id,account_id,order_item_id,kind,amount_cents,percentage_basis_points,reason,authorized_by)
    values(request.venue_id,request.account_id,case when request.kind='ITEM_COMPLIMENTARY' then (request.items->0->>'item_id')::uuid end,request.kind,(p_quote->>'amount_cents')::bigint,
      case when request.kind='PERCENT' then request.value::integer end,request.reason,private.effective_user_id()) returning id into discount_ref;
  select array_agg(value::uuid) into units from jsonb_array_elements_text(coalesce(nullif(p_quote->'units','null'::jsonb),'[]'));
  perform private.allocate_billing_discount(discount_ref,units);
  update public.discount_requests set status='APPLIED',discount_id=discount_ref,resolved_by=private.effective_user_id(),resolved_at=now() where id=request.id;
  perform private.refresh_account_payment_status(request.account_id);
  return discount_ref;
end $$;

create function public.request_discount(p_account uuid,p_kind text,p_value bigint,p_items jsonb,p_reason text,p_version bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare account public.accounts; quote jsonb; previous jsonb; request_ref uuid; discount_ref uuid;
begin
  select * into account from public.accounts where id=p_account for update;
  if account.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(account.venue_id,array['ADMIN','CASHIER']::public.user_role[]);
  previous:=private.idempotency_begin('request_discount',p_key,jsonb_build_object('account',p_account,'kind',p_kind,'value',p_value,'items',p_items,'reason',p_reason,'version',p_version));
  if previous is not null then return previous; end if;
  if p_version is distinct from account.version then raise exception 'VERSION_CONFLICT'; end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'REASON_REQUIRED'; end if;
  quote:=private.discount_quote(account.id,p_kind,p_value,p_items);
  insert into public.discount_requests(venue_id,account_id,kind,value,items,reason,requested_by,quoted_amount_cents,account_version)
    values(account.venue_id,account.id,p_kind,p_value,p_items,trim(p_reason),private.effective_user_id(),(quote->>'amount_cents')::bigint,account.version) returning id into request_ref;
  if quote->>'policy'='CASHIER_AUTONOMOUS' then discount_ref:=private.apply_discount_request(request_ref,quote);
  else
    insert into public.notifications(venue_id,recipient_role,category,title,resource_type,resource_id)
      values(account.venue_id,'ADMIN','DISCOUNT_APPROVAL','Sconto o omaggio da approvare','accounts',account.id);
    perform private.emit_signal('ACCOUNT',account.venue_id,account.id,account.id);
  end if;
  return private.idempotency_finish('request_discount',p_key,jsonb_build_object('id',request_ref,'status',case when discount_ref is null then 'PENDING' else 'APPLIED' end,'discount_id',discount_ref));
end $$;

create function public.preview_discount_request(p_request uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare request public.discount_requests;
begin
  select * into request from public.discount_requests where id=p_request;
  if request.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(request.venue_id,array['ADMIN']::public.user_role[],false);
  if request.status<>'PENDING' then raise exception 'INVALID_DISCOUNT'; end if;
  return (private.discount_quote(request.account_id,request.kind,request.value,request.items)-'units')||jsonb_build_object('request_id',request.id,'reason',request.reason,'original_amount_cents',request.quoted_amount_cents);
end $$;

create function public.resolve_discount_request(p_request uuid,p_approve boolean,p_reason text,p_version bigint,p_amount bigint,p_grant uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare request public.discount_requests; quote jsonb; previous jsonb; discount_ref uuid;
begin
  select * into request from public.discount_requests where id=p_request;
  if request.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(request.venue_id,array['ADMIN']::public.user_role[]);
  perform 1 from public.accounts where id=request.account_id for update;
  select * into request from public.discount_requests where id=p_request for update;
  previous:=private.idempotency_begin('resolve_discount',p_key,jsonb_build_object('request',p_request,'approve',p_approve,'reason',p_reason,'version',p_version,'amount',p_amount));
  if previous is not null then return previous; end if;
  if request.status<>'PENDING' or p_approve is null or p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'INVALID_DISCOUNT'; end if;
  perform private.consume_step_up(p_grant,'DISCOUNT_APPROVAL',request.id);
  if p_approve then
    quote:=private.discount_quote(request.account_id,request.kind,request.value,request.items);
    if (quote->>'version')::bigint is distinct from p_version or (quote->>'amount_cents')::bigint is distinct from p_amount then raise exception 'VERSION_CONFLICT'; end if;
    -- Save the decision before the request becomes immutable in its terminal state.
    update public.discount_requests set decision_reason=trim(p_reason) where id=request.id;
    discount_ref:=private.apply_discount_request(request.id,quote);
  else update public.discount_requests set status='REJECTED',decision_reason=trim(p_reason),resolved_by=private.effective_user_id(),resolved_at=now() where id=request.id; end if;
  perform private.emit_signal('ACCOUNT',request.venue_id,request.account_id,request.account_id);
  return private.idempotency_finish('resolve_discount',p_key,jsonb_build_object('id',request.id,'status',case when p_approve then 'APPLIED' else 'REJECTED' end,'discount_id',discount_ref));
end $$;

create function public.get_billing_workspace(p_account uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare venue uuid;
begin
  select venue_id into venue from public.accounts where id=p_account;
  if venue is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(venue,array['ADMIN','CASHIER']::public.user_role[],false);
  return jsonb_build_object('balance',private.account_balance(p_account),'version',(select version from public.accounts where id=p_account),
    'discount_policy',(select discount_policy from public.venue_settings where venue_id=venue),'complimentary_policy',(select complimentary_policy from public.venue_settings where venue_id=venue),
    'items',coalesce((select jsonb_agg(to_jsonb(row) order by row.order_item_id) from (
      select b.order_item_id,i.dish_name,count(*) quantity,sum(b.gross_cents) gross_cents,sum(b.discount_cents) discount_cents,sum(b.net_cents) net_cents,sum(b.paid_cents) paid_cents,sum(b.pending_cents) pending_cents,
        sum(b.available_cents) available_cents,count(*) filter(where b.pending_cents=0 and b.available_cents>0) selectable_quantity,
        jsonb_agg(jsonb_build_object('number',b.unit_number,'available_cents',b.available_cents,'pending_cents',b.pending_cents,'paid_cents',b.paid_cents) order by b.unit_number) units
      from private.billing_balance(p_account) b join public.order_items i on i.id=b.order_item_id group by b.order_item_id,i.dish_name) row),'[]'),
    'requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at,r.id) from public.discount_requests r where r.account_id=p_account and r.status='PENDING'),'[]'));
end $$;

grant execute on function public.preview_discount(uuid,text,bigint,jsonb),public.request_discount(uuid,text,bigint,jsonb,text,bigint,uuid),public.preview_discount_request(uuid),
  public.resolve_discount_request(uuid,boolean,text,bigint,bigint,uuid,uuid),public.get_billing_workspace(uuid) to authenticated;

create or replace function public.authorize_sensitive_action(p_action text,p_resource uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare venue uuid; actor uuid;
begin
  case p_action
    when 'REFUND','CANCEL_PAYMENT' then select venue_id into venue from public.payments where id=p_resource;
      if venue is null then raise exception 'NOT_FOUND'; end if;
      actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
    when 'FORCE_CLOSE','REOPEN_ACCOUNT' then select venue_id into venue from public.accounts where id=p_resource;
      if venue is null then raise exception 'NOT_FOUND'; end if;
      actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
    when 'DISCOUNT_APPROVAL' then select venue_id into venue from public.discount_requests where id=p_resource;
      if venue is null then raise exception 'NOT_FOUND'; end if;
      actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
    when 'CASH_RECONCILIATION' then select venue_id into venue from public.cash_reconciliation_requests where id=p_resource;
      if venue is null then raise exception 'NOT_FOUND'; end if;
      actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
    when 'FEATURE_CHANGE','INSTALLATION_STATUS','IMPERSONATION','RESTORE','DECOMMISSION','PRIVILEGED_STAFF' then actor:=private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
    when 'STAFF_CHANGE' then actor:=private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
    else raise exception 'UNKNOWN_SENSITIVE_ACTION';
  end case;
  if private.impersonation_id() is not null then raise exception 'EXIT_IMPERSONATION_FOR_STEP_UP'; end if;
  return jsonb_build_object('user_id',actor,'session_id',private.jwt_session_id());
end $$;
commit;
