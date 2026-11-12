begin;

drop function public.force_close_account(uuid,text,uuid);

create or replace function public.force_close_account(p_account uuid,p_reason text,p_step_up uuid,p_key uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.accounts; previous jsonb;
begin
  perform private.lock_floor((select venue_id from public.accounts where id=p_account));
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['ADMIN']::public.user_role[]);
  previous:=private.idempotency_begin('force_close',p_key,jsonb_build_object('account',p_account,'reason',p_reason));
  if previous is not null then return; end if;
  perform private.consume_step_up(p_step_up,'FORCE_CLOSE',a.id);
  if p_reason is null or length(trim(p_reason)) not between 8 and 2000 then raise exception 'REASON_REQUIRED'; end if;
  if a.status='CLOSED' then raise exception 'ACCOUNT_CLOSED'; end if;
  if exists(select 1 from public.payments where account_id=a.id and status='PENDING') then raise exception 'PENDING_PAYMENT_RECONCILIATION_REQUIRED'; end if;
  perform private.audit('ACCOUNT_FORCE_CLOSED','accounts',a.id,a.venue_id,private.account_balance(a.id),jsonb_build_object('status','CLOSED','reason',trim(p_reason)));
  update public.accounts set status='CLOSED',closed_at=now(),access_epoch=access_epoch+1 where id=a.id;
  delete from private.customer_access_codes where account_id=a.id;
  update private.customer_sessions set revoked_at=now() where account_id=a.id and revoked_at is null;
  if a.floor_released_at is null then perform private.release_account_floor(a.id,a.table_id); end if;
  perform private.idempotency_finish('force_close',p_key,jsonb_build_object('id',a.id));
end $$;

drop function public.reopen_account(uuid,text,uuid);

create or replace function public.reopen_account(p_account uuid,p_reason text,p_step_up uuid,p_key uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.accounts; previous jsonb;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['ADMIN']::public.user_role[]);
  previous:=private.idempotency_begin('reopen_account',p_key,jsonb_build_object('account',p_account,'reason',p_reason));
  if previous is not null then return; end if;
  perform private.consume_step_up(p_step_up,'REOPEN_ACCOUNT',a.id);
  if a.status<>'CLOSED' or p_reason is null or length(trim(p_reason)) not between 8 and 2000 then raise exception 'INVALID_REOPEN'; end if;
  update public.accounts set status='AT_CASHIER',closed_at=null,access_epoch=access_epoch+1 where id=a.id;
  perform private.refresh_account_payment_status(a.id);
  -- Financial reopening must not change the state of a table now used by other guests.
  perform private.audit('ACCOUNT_REOPENED','accounts',a.id,a.venue_id,jsonb_build_object('status','CLOSED'),jsonb_build_object('reason',trim(p_reason),'status',(select status from public.accounts where id=a.id)));
  perform private.idempotency_finish('reopen_account',p_key,jsonb_build_object('id',a.id));
end $$;

grant execute on function public.force_close_account(uuid,text,uuid,uuid),public.reopen_account(uuid,text,uuid,uuid) to authenticated;
commit;
