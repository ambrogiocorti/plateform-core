begin;
create table public.equal_split_plans (
  id uuid primary key references public.account_splits(id), venue_id uuid not null references public.venues(id), account_id uuid not null,
  total_cents bigint not null check(total_cents>0), parts integer not null check(parts between 2 and 1000),
  status text not null default 'ACTIVE' check(status in ('ACTIVE','OBSOLETE')), created_at timestamptz not null default now(), obsolete_at timestamptz,
  unique(venue_id,id), foreign key(venue_id,account_id) references public.accounts(venue_id,id)
);
create unique index current_equal_plan on public.equal_split_plans(account_id) where status='ACTIVE';
create table public.equal_split_shares (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), plan_id uuid not null,
  ordinal integer not null check(ordinal between 1 and 1000), amount_cents bigint not null check(amount_cents>=0), unique(plan_id,ordinal), unique(venue_id,id),
  foreign key(venue_id,plan_id) references public.equal_split_plans(venue_id,id)
);
create table public.equal_split_attempts (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), share_id uuid not null, payment_id uuid not null unique,
  created_at timestamptz not null default now(), foreign key(venue_id,share_id) references public.equal_split_shares(venue_id,id), foreign key(venue_id,payment_id) references public.payments(venue_id,id)
);
do $$ declare entity text; begin
  foreach entity in array array['equal_split_plans','equal_split_shares','equal_split_attempts'] loop
    execute format('alter table public.%I enable row level security',entity);
    execute format('revoke all on public.%I from public,anon,authenticated',entity);
    execute format('grant select on public.%I to authenticated',entity);
    execute format('create policy finance_read on public.%I for select to authenticated using(private.has_venue(venue_id) and private.is_role(array[''ADMIN'',''CASHIER'']::public.user_role[]))',entity);
    execute format('create trigger immutable_truncate before truncate on public.%I for each statement execute function private.immutable_record()',entity);
    if entity<>'equal_split_plans' then execute format('create trigger immutable before update or delete on public.%I for each row execute function private.immutable_record()',entity); end if;
  end loop;
end $$;
create function private.guard_equal_plan() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op<>'UPDATE' or old.status<>'ACTIVE' or new.status<>'OBSOLETE' or (to_jsonb(new)-array['status','obsolete_at']) is distinct from (to_jsonb(old)-array['status','obsolete_at']) then raise exception 'IMMUTABLE_RECORD'; end if;
  return new;
end $$;
create trigger guard_equal_plan before update or delete on public.equal_split_plans for each row execute function private.guard_equal_plan();
create trigger audit_change after insert or update on public.equal_split_plans for each row execute function private.audit_row();
create trigger audit_change after insert on public.equal_split_attempts for each row execute function private.audit_row();

create function private.equal_plan_view(p_plan uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare plan public.equal_split_plans; shares jsonb; unpaid bigint; fully_paid boolean; current_balance jsonb; account_status public.account_status;
begin
  select * into plan from public.equal_split_plans where id=p_plan;
  if plan.id is null then return null; end if;
  select jsonb_agg(jsonb_build_object('id',s.id,'ordinal',s.ordinal,'amount_cents',s.amount_cents,
    'status',case when s.amount_cents=0 then 'PAID' when a.status='PENDING' then 'PENDING' when a.status is not null then 'PAID' else 'UNPAID' end,'payment_id',a.payment_id) order by s.ordinal),
    coalesce(sum(s.amount_cents) filter(where a.status is null),0),bool_and(s.amount_cents=0 or (a.status is not null and a.status<>'PENDING'))
    into shares,unpaid,fully_paid
  from public.equal_split_shares s left join lateral (
    select p.id payment_id,p.status from public.equal_split_attempts e join public.payments p on p.id=e.payment_id
    where e.share_id=s.id and p.status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED') limit 1
  ) a on true where s.plan_id=plan.id;
  current_balance:=private.account_balance(plan.account_id);
  select status into account_status from public.accounts where id=plan.account_id;
  return jsonb_build_object('id',plan.id,'total_cents',plan.total_cents,'parts',plan.parts,'created_at',plan.created_at,'shares',shares,
    'status',case when plan.status='OBSOLETE' or unpaid<>(current_balance->>'available_cents')::bigint then 'OBSOLETE'
      when fully_paid then 'COMPLETED' when account_status='CLOSED' then 'OBSOLETE' else 'ACTIVE' end);
end $$;

create function public.create_equal_split(p_account uuid,p_parts integer,p_version bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare account public.accounts; balance jsonb; previous jsonb; plan uuid; total bigint;
begin
  select * into account from public.accounts where id=p_account for update;
  if account.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(account.venue_id,array['ADMIN','CASHIER']::public.user_role[]);
  previous:=private.idempotency_begin('equal_split',p_key,jsonb_build_object('account',p_account,'parts',p_parts,'version',p_version));
  if previous is not null then return previous; end if;
  if p_version is distinct from account.version then raise exception 'VERSION_CONFLICT'; end if;
  if account.status='CLOSED' or p_parts is null or p_parts not between 2 and 1000 then raise exception 'INVALID_SPLIT'; end if;
  balance:=private.account_balance(account.id);total:=(balance->>'available_cents')::bigint;
  if (balance->>'pending_cents')::bigint>0 then raise exception 'PENDING_PAYMENT_RECONCILIATION_REQUIRED'; end if;
  if total<=0 then raise exception 'INVALID_SPLIT'; end if;
  update public.equal_split_plans set status='OBSOLETE',obsolete_at=now() where account_id=account.id and status='ACTIVE';
  insert into public.account_splits(venue_id,source_account_id,kind,details,operator_user_id)
    values(account.venue_id,account.id,'EQUAL',jsonb_build_object('total_cents',total,'parts',p_parts,'account_version',p_version),private.effective_user_id()) returning id into plan;
  insert into public.equal_split_plans(id,venue_id,account_id,total_cents,parts) values(plan,account.venue_id,account.id,total,p_parts);
  insert into public.equal_split_shares(venue_id,plan_id,ordinal,amount_cents)
    select account.venue_id,plan,n,total/p_parts+case when n<=total%p_parts then 1 else 0 end from generate_series(1,p_parts) n;
  perform private.emit_signal('ACCOUNT',account.venue_id,account.id,account.id);
  return private.idempotency_finish('equal_split',p_key,private.equal_plan_view(plan));
end $$;
grant execute on function public.create_equal_split(uuid,integer,bigint,uuid) to authenticated;

-- The replacement below keeps the legacy idempotency payload unchanged for non-share payments.
alter function public.create_payment(uuid,uuid,bigint,bigint,public.payment_method,uuid,jsonb) rename to create_unassigned_payment;
alter function public.create_unassigned_payment(uuid,uuid,bigint,bigint,public.payment_method,uuid,jsonb) set schema private;
revoke all on function private.create_unassigned_payment(uuid,uuid,bigint,bigint,public.payment_method,uuid,jsonb) from authenticated;

create function public.create_payment(p_account uuid,p_register uuid,p_amount bigint,p_tip bigint,p_method public.payment_method,p_key uuid,p_items jsonb default '[]',p_share uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.accounts; share public.equal_split_shares; plan public.equal_split_plans; previous jsonb; result jsonb; view jsonb;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['ADMIN','CASHIER']::public.user_role[]);
  if p_share is null then
    return private.create_unassigned_payment(p_account,p_register,p_amount,p_tip,p_method,p_key,p_items);
  end if;
  previous:=private.idempotency_begin('equal_share_payment',p_key,jsonb_build_object('account',p_account,'register',p_register,'tip',p_tip,'method',p_method,'share',p_share));
  if previous is not null then return previous; end if;
  if p_items is distinct from '[]'::jsonb then raise exception 'INVALID_SPLIT'; end if;
  select * into share from public.equal_split_shares where id=p_share and venue_id=a.venue_id;
  select * into plan from public.equal_split_plans where id=share.plan_id and account_id=a.id;
  if plan.id is null or a.status='CLOSED' or share.amount_cents=0 then raise exception 'INVALID_SPLIT'; end if;
  view:=private.equal_plan_view(plan.id);
  if view->>'status'<>'ACTIVE' then raise exception 'SPLIT_OBSOLETE'; end if;
  if exists(select 1 from public.equal_split_attempts e join public.payments p on p.id=e.payment_id
    where e.share_id=share.id and p.status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED')) then raise exception 'SHARE_ALREADY_PAID'; end if;
  result:=private.create_unassigned_payment(a.id,p_register,share.amount_cents,p_tip,p_method,p_key,'[]');
  insert into public.equal_split_attempts(venue_id,share_id,payment_id) values(a.venue_id,share.id,(result->>'id')::uuid);
  return private.idempotency_finish('equal_share_payment',p_key,result||jsonb_build_object('share_id',share.id));
end $$;
grant execute on function public.create_payment(uuid,uuid,bigint,bigint,public.payment_method,uuid,jsonb,uuid) to authenticated;

alter function public.get_billing_workspace(uuid) rename to billing_workspace_without_shares;
alter function public.billing_workspace_without_shares(uuid) set schema private;
revoke all on function private.billing_workspace_without_shares(uuid) from authenticated;
create function public.get_billing_workspace(p_account uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; plan uuid;
begin
  result:=private.billing_workspace_without_shares(p_account);
  select id into plan from public.equal_split_plans where account_id=p_account and status='ACTIVE';
  return result||jsonb_build_object('equal_split',private.equal_plan_view(plan));
end $$;
grant execute on function public.get_billing_workspace(uuid) to authenticated;
commit;
