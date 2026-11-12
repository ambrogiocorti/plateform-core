-- Supabase grants EXECUTE directly to API roles by default, in addition to PUBLIC.
-- Remove that inheritance and rebuild an explicit allowlist from reviewed grants.
begin;
alter default privileges in schema public revoke execute on functions from public,anon,authenticated;
alter default privileges in schema public revoke all on tables from anon,authenticated;
alter default privileges in schema public revoke all on sequences from anon,authenticated;
create table private.api_permission_manifest(
  function_identity text not null,api_role text not null check(api_role in ('anon','authenticated','service_role')),
  primary key(function_identity,api_role)
);
alter table private.api_permission_manifest enable row level security;
revoke all on private.api_permission_manifest from public,anon,authenticated;
insert into private.api_permission_manifest(function_identity,api_role) values
  ('private.authorize(uuid,public.user_role[],boolean)','authenticated'),
  ('private.can_read_account(uuid)','authenticated'),
  ('private.can_read_item(uuid)','authenticated'),
  ('private.can_read_order(uuid)','authenticated'),
  ('private.can_read_signal(public.realtime_signals)','anon'),
  ('private.can_read_signal(public.realtime_signals)','authenticated'),
  ('private.can_use_register(uuid)','authenticated'),
  ('private.can_work_station(uuid,uuid)','authenticated'),
  ('private.current_role()','authenticated'),
  ('private.current_scope()','authenticated'),
  ('private.effective_user_id()','authenticated'),
  ('private.has_venue(uuid)','authenticated'),
  ('private.installation_active()','authenticated'),
  ('private.is_role(public.user_role[])','authenticated'),
  ('private.real_role()','authenticated'),
  ('private.responsible_waiter(uuid)','authenticated'),
  ('public.activate_room_layout(uuid,bigint,uuid)','authenticated'),
  ('public.assign_operational_staff(uuid,uuid,text,uuid,boolean)','authenticated'),
  ('public.assign_table(uuid,uuid,boolean)','authenticated'),
  ('public.assign_table_group(uuid,uuid[],boolean,bigint)','authenticated'),
  ('public.assign_waiter(uuid,uuid,text,uuid,uuid)','authenticated'),
  ('public.attach_customer_session(uuid,uuid,uuid,integer)','service_role'),
  ('public.authorize_health_probe()','authenticated'),
  ('public.authorize_sensitive_action(text,uuid)','authenticated'),
  ('public.begin_impersonation(uuid,text,uuid,uuid)','authenticated'),
  ('public.begin_staff_admin_job(text,jsonb,uuid,uuid)','authenticated'),
  ('public.bootstrap_technical_user(uuid,text)','service_role'),
  ('public.call_waiter(uuid,text)','authenticated'),
  ('public.cancel_manual_payment(uuid,text,uuid)','authenticated'),
  ('public.cancel_print_job(uuid)','authenticated'),
  ('public.change_installation_status(public.installation_status,bigint,text,uuid,uuid)','authenticated'),
  ('public.change_reservation_privacy(uuid,bigint,text,jsonb,text,uuid,uuid)','authenticated'),
  ('public.claim_customer_identity_cleanup()','service_role'),
  ('public.claim_print_job(uuid)','authenticated'),
  ('public.claim_provider_operation(uuid)','service_role'),
  ('public.claim_staff_admin_job(uuid)','service_role'),
  ('public.close_account(uuid)','authenticated'),
  ('public.complete_staff_login(text,text,text)','authenticated'),
  ('public.complete_staff_login(text,text,text,uuid,text)','authenticated'),
  ('public.configure_authentication(bigint,boolean,boolean,integer,integer,uuid,uuid)','authenticated'),
  ('public.configure_booking_rules(uuid,uuid,integer,integer,integer,integer,integer,text)','authenticated'),
  ('public.configure_data_retention(bigint,jsonb,uuid,uuid)','authenticated'),
  ('public.configure_dish(uuid,jsonb,uuid[])','authenticated'),
  ('public.configure_feature(text,boolean,uuid)','authenticated'),
  ('public.configure_ingredient_allergens(uuid,uuid[])','authenticated'),
  ('public.configure_station_printer(uuid,uuid,boolean,bigint)','authenticated'),
  ('public.configure_system_limits(jsonb,uuid)','authenticated'),
  ('public.configure_table_join(uuid,uuid,boolean)','authenticated'),
  ('public.configure_table_label(uuid,public.table_status,text,text,text,integer,uuid)','authenticated'),
  ('public.configure_venue_dish(uuid,uuid,boolean,bigint,integer,uuid,uuid[])','authenticated'),
  ('public.configure_venue_operations(uuid,jsonb)','authenticated'),
  ('public.confirm_manual_payment(uuid,boolean)','authenticated'),
  ('public.consume_edge_rate_limit(text,integer,integer)','service_role'),
  ('public.create_account(uuid,text,integer,text,uuid)','authenticated'),
  ('public.create_customer_order_request(uuid,jsonb,uuid)','authenticated'),
  ('public.create_equal_split(uuid,integer,bigint,uuid)','authenticated'),
  ('public.create_order(uuid,jsonb,uuid,bigint)','authenticated'),
  ('public.create_payment(uuid,uuid,bigint,bigint,public.payment_method,uuid,jsonb)','authenticated'),
  ('public.create_payment(uuid,uuid,bigint,bigint,public.payment_method,uuid,jsonb,uuid)','authenticated'),
  ('public.create_public_reservation(uuid,uuid,date,time,text,text,text,integer,jsonb,uuid,text)','service_role'),
  ('public.create_refund(uuid,bigint,bigint,text,uuid,uuid)','authenticated'),
  ('public.create_refund(uuid,bigint,bigint,text,uuid,uuid,uuid)','authenticated'),
  ('public.create_venue(text,text,text,text,text,text)','authenticated'),
  ('public.create_walk_in(uuid,uuid,integer,text,uuid)','authenticated'),
  ('public.deliver_step(uuid,boolean)','authenticated'),
  ('public.enable_impersonation_write(uuid,boolean,uuid)','authenticated'),
  ('public.end_impersonation(uuid)','authenticated'),
  ('public.export_reservation_personal_data(uuid,uuid)','authenticated'),
  ('public.finish_asset_upload(uuid,boolean,text)','service_role'),
  ('public.finish_customer_identity_cleanup(uuid,uuid,boolean)','service_role'),
  ('public.finish_print_job(uuid,uuid,boolean,text)','authenticated'),
  ('public.finish_provider_operation(uuid,uuid,text,text,bigint,text,text,text)','service_role'),
  ('public.finish_staff_admin_job(uuid,uuid,boolean)','service_role'),
  ('public.force_close_account(uuid,text,uuid)','authenticated'),
  ('public.force_close_account(uuid,text,uuid,uuid)','authenticated'),
  ('public.get_account_balance(uuid)','authenticated'),
  ('public.get_account_payments(uuid,timestamptz,uuid,integer)','authenticated'),
  ('public.get_account_workspace(uuid,timestamptz,uuid,integer)','authenticated'),
  ('public.get_auth_requirements()','authenticated'),
  ('public.get_billing_workspace(uuid)','authenticated'),
  ('public.get_booking_configuration(uuid)','anon'),
  ('public.get_booking_configuration(uuid)','authenticated'),
  ('public.get_customer_account(uuid)','authenticated'),
  ('public.get_floor_workspace(uuid)','authenticated'),
  ('public.get_host_reservations(uuid,date,uuid,public.reservation_status,text,time,uuid,integer)','authenticated'),
  ('public.get_impersonation_context(uuid)','authenticated'),
  ('public.get_kitchen_board(uuid)','authenticated'),
  ('public.get_notification_summary(uuid)','authenticated'),
  ('public.get_offline_operational_workspace(uuid)','authenticated'),
  ('public.get_operational_statistics(uuid,date,date)','authenticated'),
  ('public.get_payment_registers(uuid)','authenticated'),
  ('public.get_print_bridge_authorization(uuid,uuid)','authenticated'),
  ('public.get_print_jobs(uuid,timestamptz,uuid,text,int)','authenticated'),
  ('public.get_privacy_configuration()','authenticated'),
  ('public.get_public_menu(uuid)','anon'),
  ('public.get_public_menu(uuid)','authenticated'),
  ('public.get_public_site()','anon'),
  ('public.get_public_site()','authenticated'),
  ('public.get_reservation_details(uuid)','authenticated'),
  ('public.get_service_reconciliation(uuid)','authenticated'),
  ('public.get_technical_workspace()','authenticated'),
  ('public.heartbeat_device()','authenticated'),
  ('public.ingest_edge_telemetry(text,text,text,text,integer,text,integer,uuid)','service_role'),
  ('public.issue_step_up_grant(uuid,uuid,text,uuid)','service_role'),
  ('public.lock_staff_session()','authenticated'),
  ('public.mark_step_ready(uuid)','authenticated'),
  ('public.merge_accounts(uuid,uuid,bigint,bigint,uuid)','authenticated'),
  ('public.merge_tables(uuid,uuid)','authenticated'),
  ('public.modify_order(uuid,bigint,uuid[],jsonb,text,uuid)','authenticated'),
  ('public.move_account_items(uuid,uuid,text,jsonb,bigint,bigint,uuid)','authenticated'),
  ('public.move_table(uuid,uuid,boolean)','authenticated'),
  ('public.open_service_session(uuid,uuid,uuid,bigint,uuid)','authenticated'),
  ('public.prepare_offline_authorization()','authenticated'),
  ('public.prepare_provider_operation(uuid,uuid)','authenticated'),
  ('public.prepare_staff_job_profile(uuid,uuid)','service_role'),
  ('public.preview_discount(uuid,text,bigint,jsonb)','authenticated'),
  ('public.preview_discount_request(uuid)','authenticated'),
  ('public.provision_staff_profile(uuid,text,public.user_role,public.user_scope,uuid[],uuid)','authenticated'),
  ('public.purge_realtime_signals()','service_role'),
  ('public.record_health_probe(text,text,integer,text,uuid)','service_role'),
  ('public.regenerate_account_code(uuid)','authenticated'),
  ('public.register_customer_identity_retention(uuid)','service_role'),
  ('public.release_provider_lease(uuid,uuid)','service_role'),
  ('public.reopen_account(uuid,text,uuid)','authenticated'),
  ('public.reopen_account(uuid,text,uuid,uuid)','authenticated'),
  ('public.request_account_print(uuid,uuid,text,uuid)','authenticated'),
  ('public.request_discount(uuid,text,bigint,jsonb,text,bigint,uuid)','authenticated'),
  ('public.request_order_change(uuid,text,jsonb,text,bigint,uuid)','authenticated'),
  ('public.request_service_close(uuid,jsonb,uuid)','authenticated'),
  ('public.reserve_asset_upload(text,uuid,uuid,bigint,text)','authenticated'),
  ('public.reserve_asset_upload_command(text,uuid,uuid,bigint,text,text,uuid)','authenticated'),
  ('public.reset_staff_pin(uuid,uuid)','authenticated'),
  ('public.resolve_customer_order(uuid,boolean,text)','authenticated'),
  ('public.resolve_discount_request(uuid,boolean,text,bigint,bigint,uuid,uuid)','authenticated'),
  ('public.resolve_order_change(uuid,boolean,text,uuid)','authenticated'),
  ('public.resolve_service_reconciliation(uuid,boolean,text,uuid,uuid)','authenticated'),
  ('public.resolve_sync_conflict(uuid,text,text,uuid)','authenticated'),
  ('public.resume_staff_admin_job(uuid,uuid)','authenticated'),
  ('public.retry_print_job(uuid,boolean,uuid)','authenticated'),
  ('public.return_order_item(uuid,text,bigint,uuid)','authenticated'),
  ('public.revoke_device(uuid)','authenticated'),
  ('public.revoke_staff_for_reset(uuid,uuid,boolean)','authenticated'),
  ('public.run_data_retention(integer)','service_role'),
  ('public.save_booking_slot(uuid,uuid,date,time,boolean,integer,integer,text,uuid)','authenticated'),
  ('public.save_brand_content(bigint,jsonb,jsonb,jsonb,uuid)','authenticated'),
  ('public.save_configuration(text,uuid,uuid,jsonb,bigint)','authenticated'),
  ('public.save_configuration_command(text,uuid,uuid,jsonb,bigint,uuid)','authenticated'),
  ('public.save_dish_composition(uuid,bigint,jsonb,uuid[],jsonb,uuid)','authenticated'),
  ('public.save_feature_license(text,boolean,bigint,uuid,uuid)','authenticated'),
  ('public.save_financial_settings(uuid,bigint,public.payment_method[],text,text,uuid)','authenticated'),
  ('public.save_operational_settings(uuid,bigint,jsonb,uuid)','authenticated'),
  ('public.save_print_device(uuid,uuid,bigint,text,text,text,public.user_role[],boolean,uuid)','authenticated'),
  ('public.save_register_finance(uuid,bigint,public.payment_method[],uuid,uuid)','authenticated'),
  ('public.save_reservation_form(uuid,uuid,bigint,text,jsonb,uuid)','authenticated'),
  ('public.save_room_layout(uuid,bigint,jsonb,jsonb,uuid)','authenticated'),
  ('public.save_shift(uuid,uuid,uuid,timestamptz,timestamptz,bigint,uuid)','authenticated'),
  ('public.save_shift_local(uuid,uuid,uuid,timestamp,timestamp,bigint,uuid)','authenticated'),
  ('public.save_staff_reservation(uuid,uuid,bigint,jsonb,jsonb,uuid)','authenticated'),
  ('public.save_venue_details(uuid,bigint,jsonb,uuid)','authenticated'),
  ('public.save_venue_dish(uuid,uuid,bigint,boolean,bigint,integer,uuid,uuid[],uuid)','authenticated'),
  ('public.search_accounts(uuid,text,text,uuid,timestamptz,timestamptz,timestamptz,uuid,integer)','authenticated'),
  ('public.search_audit(uuid,uuid,uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid,public.user_role,boolean,text)','authenticated'),
  ('public.search_operational_resources(text,uuid)','authenticated'),
  ('public.search_privacy_reservations(uuid,text,uuid)','authenticated'),
  ('public.service_database_probe()','service_role'),
  ('public.set_cash_register_open(uuid,boolean)','authenticated'),
  ('public.set_installation_status(public.installation_status,uuid,text)','authenticated'),
  ('public.set_staff_pin(text)','authenticated'),
  ('public.set_table_available(uuid)','authenticated'),
  ('public.setup_installation(text,text,text,text,jsonb)','authenticated'),
  ('public.split_tables(uuid)','authenticated'),
  ('public.start_order_step(uuid)','authenticated'),
  ('public.store_offline_authorization(uuid,text,text)','service_role'),
  ('public.suggest_tables(uuid)','authenticated'),
  ('public.sync_offline_event(uuid,uuid,uuid,uuid,uuid,text,bigint,jsonb,timestamptz,uuid)','authenticated'),
  ('public.transition_notification(uuid,public.notification_status)','authenticated'),
  ('public.transition_order_item(uuid,public.order_status,bigint)','authenticated'),
  ('public.transition_reservation(uuid,public.reservation_status,bigint)','authenticated'),
  ('public.transition_waiter_call(uuid,boolean)','authenticated'),
  ('public.unlock_staff_session(text)','authenticated'),
  ('public.update_incident(uuid,uuid,text,public.incident_severity,text,text,text,text,bigint,uuid)','authenticated'),
  ('public.update_reservation_notes(uuid,text,text,bigint)','authenticated'),
  ('public.verify_customer_code(uuid,text)','service_role');
-- Declarations for signatures replaced earlier in the migration chain are intentionally skipped.
do $$ declare routine record; permission record; identity regprocedure;
begin
  for routine in select p.oid::regprocedure as identity from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f' loop
    execute format('revoke execute on function %s from public,anon,authenticated',routine.identity);
  end loop;
  for permission in select * from private.api_permission_manifest loop
    identity:=to_regprocedure(permission.function_identity);
    if identity is not null then
      execute format('grant execute on function %s to %I',identity,permission.api_role);
    end if;
  end loop;
end $$;
create or replace function private.audit(p_action text,p_resource text,p_id uuid,p_venue uuid,p_old jsonb default null,p_new jsonb default null,p_result text default 'SUCCESS')
returns void language plpgsql security definer set search_path='' as $$
declare rid uuid:=gen_random_uuid(); cid uuid; subject uuid:=private.effective_user_id(); request_headers jsonb; detail jsonb:=coalesce(p_new,p_old,'{}');
  account_ref uuid; order_ref uuid; table_ref uuid; payment_ref uuid; register_ref uuid; service_ref uuid; device_ref uuid; customer_ref uuid; payment public.payments;
begin
  request_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if request_headers->>'x-request-id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then rid:=(request_headers->>'x-request-id')::uuid; end if;
  cid:=private.request_correlation_id(rid);
  account_ref:=(detail->>'account_id')::uuid; order_ref:=(detail->>'order_id')::uuid; table_ref:=(detail->>'table_id')::uuid;
  register_ref:=(detail->>'cash_register_id')::uuid; service_ref:=(detail->>'service_session_id')::uuid;
  payment_ref:=coalesce((detail->>'payment_id')::uuid,(detail->>'original_payment_id')::uuid);
  if p_resource='accounts' then account_ref:=p_id;
  elsif p_resource='orders' then order_ref:=p_id;
  elsif p_resource='payments' then payment_ref:=p_id;
  elsif p_resource='tables' then table_ref:=p_id;
  elsif p_resource='cash_registers' then register_ref:=p_id;
  elsif p_resource='service_sessions' then service_ref:=p_id;
  end if;
  if payment_ref is not null then
    select * into payment from public.payments where id=payment_ref;
    account_ref:=coalesce(account_ref,payment.account_id); register_ref:=coalesce(register_ref,payment.cash_register_id); service_ref:=coalesce(service_ref,payment.service_session_id);
  end if;
  if account_ref is null and order_ref is not null then select account_id into account_ref from public.orders where id=order_ref; end if;
  if table_ref is null and account_ref is not null then select table_id into table_ref from public.accounts where id=account_ref; end if;
  select device_id into device_ref from private.staff_sessions where session_id=private.jwt_session_id() and user_id=auth.uid();
  select id into customer_ref from private.customer_sessions where auth_user_id=auth.uid() and (account_ref is null or account_id=account_ref) order by created_at desc limit 1;
  insert into public.audit_log(venue_id,actor_type,actor_user_id,actor_role,action,resource_type,resource_id,operation,result,
    session_id,device_id,customer_session_id,table_id,account_id,order_id,payment_id,cash_register_id,service_session_id,
    old_values,new_values,request_id,correlation_id,impersonated_by,impersonation_write_enabled,offline_origin,synced_at)
  values(p_venue,case when auth.uid() is null then 'SYSTEM' when exists(select 1 from public.staff_profiles where id=coalesce(subject,auth.uid())) then 'STAFF' else 'CUSTOMER' end,
    coalesce(subject,auth.uid()),case when auth.uid() is null then 'SYSTEM'::public.user_role else coalesce((select role from public.staff_profiles where id=coalesce(subject,auth.uid())),'CUSTOMER'::public.user_role) end,
    p_action,p_resource,p_id,p_action,p_result,private.jwt_session_id(),device_ref,customer_ref,table_ref,account_ref,order_ref,payment_ref,register_ref,service_ref,
    private.audit_values(p_old),private.audit_values(p_new),rid,cid,
    case when private.impersonation_id() is not null then auth.uid() end,
    coalesce((select write_enabled from private.impersonation_sessions where id=private.impersonation_id()),false),
    coalesce(nullif(current_setting('plateform.offline_origin',true),''),'false')::boolean,
    case when coalesce(nullif(current_setting('plateform.offline_origin',true),''),'false')::boolean then now() end);
end $$;
notify pgrst,'reload schema';
commit;
