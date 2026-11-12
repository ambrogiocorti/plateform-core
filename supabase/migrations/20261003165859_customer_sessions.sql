begin;
create function public.verify_customer_code(p_public_table uuid,p_code text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.tables; a public.accounts;
begin
  if p_code !~ '^[0-9]{6}$' or not private.installation_active() then return null; end if;
  select * into t from public.tables where public_table_id=p_public_table and active;
  if t.id is null or not exists(select 1 from public.venues where id=t.venue_id and active and operational_status='OPEN') then return null; end if;
  select account.* into a from public.accounts account join private.customer_access_codes code on code.account_id=account.id
    where account.table_id=t.id and account.status<>'CLOSED' and code.expires_at>now() and extensions.crypt(p_code,code.code_hash)=code.code_hash;
  if a.id is null then
    perform private.audit('CUSTOMER_CODE_FAILED','tables',t.id,t.venue_id,null,null,'DENIED'); return null;
  end if;
  return jsonb_build_object('account_id',a.id,'table_id',t.id,'access_epoch',a.access_epoch);
end $$;
create function public.attach_customer_session(p_user uuid,p_account uuid,p_table uuid,p_epoch integer) returns uuid language plpgsql security definer set search_path='' as $$
declare a public.accounts; ref uuid;
begin
  select * into a from public.accounts where id=p_account for update;
  if not private.installation_active() or a.id is null or a.status='CLOSED' or a.table_id<>p_table or a.access_epoch<>p_epoch
    or not exists(select 1 from private.customer_access_codes where account_id=a.id and expires_at>now()) then raise exception 'CUSTOMER_SESSION_INVALIDATED'; end if;
  if exists(select 1 from public.staff_profiles where id=p_user) then raise exception 'CUSTOMER_IDENTITY_REQUIRED'; end if;
  insert into private.customer_sessions(account_id,auth_user_id,table_id,access_epoch,expires_at)
    values(a.id,p_user,p_table,p_epoch,least(now()+interval '12 hours',(select expires_at from private.customer_access_codes where account_id=a.id))) returning id into ref;
  perform private.audit('CUSTOMER_SESSION_CREATED','accounts',a.id,a.venue_id);
  return ref;
end $$;
grant execute on function public.verify_customer_code(uuid,text),public.attach_customer_session(uuid,uuid,uuid,integer) to service_role;

create function public.get_customer_account(p_public_table uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.accounts; settings public.venue_settings;
begin
  select account.* into a from public.accounts account join public.tables t on t.id=account.table_id
    where t.public_table_id=p_public_table and private.owns_customer_account(account.id) order by account.created_at desc limit 1;
  if a.id is null then raise exception 'CUSTOMER_SESSION_REQUIRED' using errcode='42501'; end if;
  select * into settings from public.venue_settings where venue_id=a.venue_id;
  return jsonb_build_object('id',a.id,'name',a.account_name,'covers',a.covers,'venue_id',a.venue_id,'balance',private.account_balance(a.id),
    'customer_ordering',case when exists(select 1 from public.feature_flags where name='CLIENT_ORDERING' and licensed) then settings.customer_ordering else 'DISABLED' end,
    'bill_request_enabled',settings.customer_bill_request,
    'items',coalesce((select jsonb_agg(jsonb_build_object('name',i.dish_name,'quantity',i.quantity,'unit_price_cents',i.unit_price_cents,'ordered_at',o.created_at))
      from public.order_items i join public.orders o on o.id=i.order_id where o.account_id=a.id and i.status<>'CANCELLED'),'[]'),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'created_at',r.created_at)) from public.customer_order_requests r where r.account_id=a.id),'[]'));
end $$;
grant execute on function public.get_customer_account(uuid) to authenticated;
commit;
