begin;
alter table public.refunds add column cash_register_id uuid;
alter table public.refunds add column service_session_id uuid;
alter table public.refunds add column operator_user_id uuid references public.staff_profiles(id);
update public.refunds r set cash_register_id=p.cash_register_id,service_session_id=p.service_session_id,operator_user_id=r.authorized_by
  from public.payments p where p.id=r.original_payment_id;
alter table public.refunds alter column cash_register_id set not null;
alter table public.refunds alter column service_session_id set not null;
alter table public.refunds alter column operator_user_id set not null;
alter table public.refunds add foreign key(venue_id,cash_register_id) references public.cash_registers(venue_id,id);
alter table public.refunds add foreign key(venue_id,service_session_id) references public.service_sessions(venue_id,id);
alter table public.refunds drop constraint refunds_amount_cents_check;
alter table public.refunds add check(amount_cents>=0 and amount_cents+tip_cents>0);

create table public.payment_reversals (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  payment_id uuid not null unique, account_id uuid not null, cash_register_id uuid not null, service_session_id uuid not null,
  amount_cents bigint not null check(amount_cents>=0),tip_cents bigint not null check(tip_cents>=0),
  reason text not null check(length(trim(reason)) between 3 and 2000), operator_user_id uuid not null references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  foreign key(venue_id,payment_id) references public.payments(venue_id,id), foreign key(venue_id,account_id) references public.accounts(venue_id,id),
  foreign key(venue_id,cash_register_id) references public.cash_registers(venue_id,id), foreign key(venue_id,service_session_id) references public.service_sessions(venue_id,id)
);
create table public.cash_journal (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  kind text not null check(kind in ('RECEIPT','REFUND','REVERSAL')), source_id uuid not null,
  payment_id uuid not null, account_id uuid not null, cash_register_id uuid not null, service_session_id uuid not null,
  method public.payment_method not null, amount_cents bigint not null, tip_cents bigint not null,
  operator_user_id uuid not null references public.staff_profiles(id), created_at timestamptz not null default now(),
  unique(kind,source_id),
  check((kind='RECEIPT' and amount_cents>0 and tip_cents>=0) or (kind in ('REFUND','REVERSAL') and amount_cents<=0 and tip_cents<=0 and amount_cents+tip_cents<0)),
  foreign key(venue_id,payment_id) references public.payments(venue_id,id), foreign key(venue_id,account_id) references public.accounts(venue_id,id),
  foreign key(venue_id,cash_register_id) references public.cash_registers(venue_id,id), foreign key(venue_id,service_session_id) references public.service_sessions(venue_id,id)
);
create index journal_service_register on public.cash_journal(service_session_id,cash_register_id,created_at);
create index journal_account on public.cash_journal(account_id,created_at);
-- Backfill historical receipts/refunds without rewriting the original payments.
insert into public.cash_journal(venue_id,kind,source_id,payment_id,account_id,cash_register_id,service_session_id,method,amount_cents,tip_cents,operator_user_id,created_at)
  select venue_id,'RECEIPT',id,id,account_id,cash_register_id,service_session_id,method,amount_cents,tip_cents,operator_user_id,coalesce(completed_at,created_at)
  from public.payments where status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED');
insert into public.cash_journal(venue_id,kind,source_id,payment_id,account_id,cash_register_id,service_session_id,method,amount_cents,tip_cents,operator_user_id,created_at)
  select r.venue_id,'REFUND',r.id,p.id,p.account_id,r.cash_register_id,r.service_session_id,r.method,-r.amount_cents,-r.tip_cents,r.operator_user_id,coalesce(r.completed_at,r.created_at)
  from public.refunds r join public.payments p on p.id=r.original_payment_id where r.status='COMPLETED';

do $$ declare entity text;
begin
  foreach entity in array array['payment_reversals','cash_journal'] loop
    execute format('alter table public.%I enable row level security',entity);
    execute format('revoke all on public.%I from public,anon,authenticated',entity);
    execute format('grant select on public.%I to authenticated',entity);
    execute format('create policy finance_read on public.%I for select to authenticated using(private.has_venue(venue_id) and private.is_role(array[''ADMIN'',''CASHIER'']::public.user_role[]))',entity);
    execute format('create trigger immutable before update or delete on public.%I for each row execute function private.immutable_record()',entity);
    execute format('create trigger immutable_truncate before truncate on public.%I for each statement execute function private.immutable_record()',entity);
    execute format('create trigger audit_change after insert on public.%I for each row execute function private.audit_row()',entity);
  end loop;
end $$;
create trigger reconciliation_no_truncate before truncate on public.cash_reconciliations for each statement execute function private.immutable_record();

create function private.guard_payment_amounts() returns trigger language plpgsql set search_path='' as $$
begin
  if (to_jsonb(new)-array['status','version','updated_at','completed_at','provider_id']) is distinct from (to_jsonb(old)-array['status','version','updated_at','completed_at','provider_id'])
    or (old.provider_id is not null and new.provider_id is distinct from old.provider_id)
    or (old.completed_at is not null and new.completed_at is distinct from old.completed_at) then raise exception 'IMMUTABLE_PAYMENT_DETAILS' using errcode='42501'; end if;
  return new;
end $$;
create trigger immutable_payment_details before update on public.payments for each row execute function private.guard_payment_amounts();
create trigger immutable_refund_details before update on public.refunds for each row execute function private.guard_payment_amounts();

create function private.post_payment_journal() returns trigger language plpgsql security definer set search_path='' as $$
declare payment public.payments; target_session uuid;
begin
  if (tg_table_name='payments' and new.status<>'COMPLETED') or (tg_table_name='refunds' and new.status<>'COMPLETED') then return new; end if;
  if tg_op='UPDATE' and old.status=new.status then return new; end if;
  target_session:=new.service_session_id;
  perform 1 from public.service_sessions where id=target_session and status='OPEN' for update;
  if not found then raise exception 'SERVICE_NOT_OPEN'; end if;
  if tg_table_name='payments' then
    insert into public.cash_journal(venue_id,kind,source_id,payment_id,account_id,cash_register_id,service_session_id,method,amount_cents,tip_cents,operator_user_id)
      values(new.venue_id,'RECEIPT',new.id,new.id,new.account_id,new.cash_register_id,new.service_session_id,new.method,new.amount_cents,new.tip_cents,new.operator_user_id) on conflict(kind,source_id) do nothing;
  else
    select * into payment from public.payments where id=new.original_payment_id;
    insert into public.cash_journal(venue_id,kind,source_id,payment_id,account_id,cash_register_id,service_session_id,method,amount_cents,tip_cents,operator_user_id)
      values(new.venue_id,'REFUND',new.id,payment.id,payment.account_id,new.cash_register_id,new.service_session_id,new.method,-new.amount_cents,-new.tip_cents,new.operator_user_id) on conflict(kind,source_id) do nothing;
  end if;
  return new;
end $$;
create trigger post_journal after insert or update on public.payments for each row execute function private.post_payment_journal();
create trigger post_journal after insert or update on public.refunds for each row execute function private.post_payment_journal();

drop function public.create_refund(uuid,bigint,bigint,text,uuid,uuid);
create function public.create_refund(p_payment uuid,p_amount bigint,p_tip bigint,p_reason text,p_step_up uuid,p_key uuid,p_register uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments; already bigint; tips_already bigint; ref uuid; result jsonb; target_register uuid; target_session uuid;
begin
  select * into p from public.payments where id=p_payment;
  if p.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(p.venue_id,array['ADMIN']::public.user_role[]);
  perform 1 from public.accounts where id=p.account_id for update;
  select * into p from public.payments where id=p_payment for update;
  result:=private.idempotency_begin('refund',p_key,jsonb_build_object('payment',p_payment,'amount',p_amount,'tip',p_tip,'reason',p_reason,'register',p_register));
  if result is not null then return result; end if;
  perform private.consume_step_up(p_step_up,'REFUND',p.id);
  if p.status not in ('COMPLETED','PARTIALLY_REFUNDED') then raise exception 'PAYMENT_NOT_REFUNDABLE'; end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'REASON_REQUIRED'; end if;
  select coalesce(sum(amount_cents),0),coalesce(sum(tip_cents),0) into already,tips_already from public.refunds where original_payment_id=p.id and status not in ('FAILED','REJECTED');
  if p_amount is null or p_amount<0 or p_tip is null or p_tip<0 or p_amount+p_tip<=0 or already+p_amount>p.amount_cents or tips_already+p_tip>p.tip_cents then raise exception 'INVALID_REFUND_AMOUNT'; end if;
  target_register:=coalesce(p_register,p.cash_register_id);
  if not private.can_use_register(target_register) or not exists(select 1 from public.cash_registers where id=target_register and venue_id=p.venue_id and active and status='OPEN') then raise exception 'REGISTER_NOT_OPEN'; end if;
  select s.id into target_session from public.service_sessions s join public.cash_register_sessions c on c.service_session_id=s.id
    where c.cash_register_id=target_register and c.closed_at is null and s.status='OPEN' for update of s;
  if target_session is null then raise exception 'SERVICE_NOT_OPEN'; end if;
  insert into public.refunds(venue_id,original_payment_id,amount_cents,tip_cents,method,authorized_by,status,reason,idempotency_key,completed_at,cash_register_id,service_session_id,operator_user_id)
    values(p.venue_id,p.id,p_amount,p_tip,p.method,private.effective_user_id(),
      case when p.method in ('STRIPE','SATISPAY_API') then 'PENDING'::public.refund_status else 'COMPLETED'::public.refund_status end,
      trim(p_reason),p_key,case when p.method not in ('STRIPE','SATISPAY_API') then now() end,target_register,target_session,private.effective_user_id()) returning id into ref;
  if p.method not in ('STRIPE','SATISPAY_API') then
    update public.payments set status=case when already+p_amount=p.amount_cents and tips_already+p_tip=p.tip_cents then 'REFUNDED'::public.payment_status else 'PARTIALLY_REFUNDED'::public.payment_status end where id=p.id;
  end if;
  return private.idempotency_finish('refund',p_key,jsonb_build_object('id',ref,'status',case when p.method in ('STRIPE','SATISPAY_API') then 'PENDING' else 'COMPLETED' end));
end $$;
grant execute on function public.create_refund(uuid,bigint,bigint,text,uuid,uuid,uuid) to authenticated;

create or replace function public.cancel_manual_payment(p_payment uuid,p_reason text,p_step_up uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare p public.payments; a public.accounts; target_session uuid; reversal uuid;
begin
  select * into p from public.payments where id=p_payment;
  if p.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(p.venue_id,array['ADMIN','CASHIER']::public.user_role[]);
  if p.method not in ('CASH','CARD_POS','SATISPAY_POS') or p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'INVALID_MANUAL_REVERSAL'; end if;
  if not private.can_use_register(p.cash_register_id) then raise exception 'REGISTER_FORBIDDEN'; end if;
  select * into a from public.accounts where id=p.account_id for update;
  select * into p from public.payments where id=p_payment for update;
  if p.status='CANCELLED' then return; end if;
  if p.status not in ('COMPLETED','PENDING') or exists(select 1 from public.refunds where original_payment_id=p.id and status not in ('FAILED','REJECTED')) then raise exception 'REFUND_WORKFLOW_REQUIRED'; end if;
  if a.status='CLOSED' then
    perform private.authorize(a.venue_id,array['ADMIN']::public.user_role[]);
    perform private.consume_step_up(p_step_up,'CANCEL_PAYMENT',p.id);
  end if;
  select s.id into target_session from public.service_sessions s join public.cash_register_sessions c on c.service_session_id=s.id
    where c.cash_register_id=p.cash_register_id and c.closed_at is null and s.status='OPEN' for update of s;
  if target_session is null then raise exception 'SERVICE_NOT_OPEN'; end if;
  insert into public.payment_reversals(venue_id,payment_id,account_id,cash_register_id,service_session_id,amount_cents,tip_cents,reason,operator_user_id)
    values(p.venue_id,p.id,p.account_id,p.cash_register_id,target_session,case when p.status='COMPLETED' then p.amount_cents else 0 end,
      case when p.status='COMPLETED' then p.tip_cents else 0 end,trim(p_reason),private.effective_user_id()) returning id into reversal;
  if p.status='COMPLETED' then
    insert into public.cash_journal(venue_id,kind,source_id,payment_id,account_id,cash_register_id,service_session_id,method,amount_cents,tip_cents,operator_user_id)
      values(p.venue_id,'REVERSAL',reversal,p.id,p.account_id,p.cash_register_id,target_session,p.method,-p.amount_cents,-p.tip_cents,private.effective_user_id());
  end if;
  update public.payments set status='CANCELLED' where id=p.id;
  if a.status='CLOSED' then update public.accounts set status='AT_CASHIER',closed_at=null,access_epoch=access_epoch+1 where id=a.id; end if;
  perform private.refresh_account_payment_status(a.id);
end $$;

create or replace function public.confirm_manual_payment(p_payment uuid,p_success boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
  select * into p from public.payments where id=p_payment;
  if p.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(p.venue_id,array['CASHIER','ADMIN']::public.user_role[]);
  if not private.can_use_register(p.cash_register_id) then raise exception 'REGISTER_FORBIDDEN' using errcode='42501'; end if;
  if p_success is null then raise exception 'INVALID_PAYMENT_RESULT'; end if;
  perform 1 from public.accounts where id=p.account_id for update;
  select * into p from public.payments where id=p_payment for update;
  if p.method not in ('CASH','CARD_POS','SATISPAY_POS') then raise exception 'PROVIDER_CONFIRMATION_REQUIRED' using errcode='42501'; end if;
  if p.status<>'PENDING' then return jsonb_build_object('id',p.id,'status',p.status); end if;
  perform 1 from public.service_sessions where id=p.service_session_id and status='OPEN' for update;
  if not found then raise exception 'SERVICE_NOT_OPEN'; end if;
  update public.payments set status=case when p_success then 'COMPLETED'::public.payment_status else 'FAILED'::public.payment_status end,
    completed_at=case when p_success then now() end where id=p.id;
  if p_success and p.tip_cents>0 then insert into public.tips(venue_id,payment_id,amount_cents) values(p.venue_id,p.id,p.tip_cents); end if;
  perform private.refresh_account_payment_status(p.account_id);
  return jsonb_build_object('id',p.id,'status',case when p_success then 'COMPLETED' else 'FAILED' end);
end $$;
commit;
