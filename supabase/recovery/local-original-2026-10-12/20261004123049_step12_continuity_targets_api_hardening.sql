begin;
create or replace function private.configure_continuity_targets_impl(
  p_version bigint,p_rpo_target_minutes integer,p_rto_target_minutes integer,
  p_backup_retention_days integer,p_restore_test_interval_days integer,p_key uuid
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare current_row private.continuity_settings; result jsonb;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED'; end if;
  if p_key is null or p_rpo_target_minutes not between 5 and 1440 or p_rto_target_minutes not between 15 and 1440
     or p_backup_retention_days not between 1 and 90 or p_restore_test_interval_days not between 1 and 90 then
    raise exception 'INVALID_CONTINUITY_TARGETS';
  end if;
  result:=private.idempotency_begin('continuity_targets',p_key,jsonb_build_object(
    'version',p_version,'rpo_target_minutes',p_rpo_target_minutes,'rto_target_minutes',p_rto_target_minutes,
    'backup_retention_days',p_backup_retention_days,'restore_test_interval_days',p_restore_test_interval_days));
  if result is not null then return result; end if;
  select * into current_row from private.continuity_settings where id for update;
  if current_row.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  update private.continuity_settings set rpo_target_minutes=p_rpo_target_minutes,rto_target_minutes=p_rto_target_minutes,
    backup_retention_days=p_backup_retention_days,restore_test_interval_days=p_restore_test_interval_days
  where id returning * into current_row;
  perform private.audit('CONTINUITY_TARGETS_CHANGED','continuity_settings',null,null,null,jsonb_build_object('version',current_row.version));
  return private.idempotency_finish('continuity_targets',p_key,jsonb_build_object(
    'version',current_row.version,'rpo_target_minutes',current_row.rpo_target_minutes,'rto_target_minutes',current_row.rto_target_minutes,
    'backup_retention_days',current_row.backup_retention_days,'restore_test_interval_days',current_row.restore_test_interval_days));
end $$;
revoke all on function private.configure_continuity_targets_impl(bigint,integer,integer,integer,integer,uuid) from public,anon;
grant execute on function private.configure_continuity_targets_impl(bigint,integer,integer,integer,integer,uuid) to authenticated;

create or replace function public.configure_continuity_targets(
  p_version bigint,p_rpo_target_minutes integer,p_rto_target_minutes integer,
  p_backup_retention_days integer,p_restore_test_interval_days integer,p_key uuid
) returns jsonb language sql security invoker set search_path=''
as $$
  select private.configure_continuity_targets_impl(
    p_version,p_rpo_target_minutes,p_rto_target_minutes,p_backup_retention_days,p_restore_test_interval_days,p_key
  )
$$;
revoke all on function public.configure_continuity_targets(bigint,integer,integer,integer,integer,uuid) from public,anon;
grant execute on function public.configure_continuity_targets(bigint,integer,integer,integer,integer,uuid) to authenticated;
commit;