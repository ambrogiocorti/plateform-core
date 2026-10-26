begin;
create function public.get_print_bridge_authorization(p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.print_jobs; device public.print_devices; profile public.restaurant_profile;
begin
  select * into job from public.print_jobs where id=p_job for update;
  if job.id is null then raise exception 'NOT_FOUND';end if;
  device:=private.print_authorize(job.print_device_id);
  if device.driver<>'BRIDGE' or job.status<>'SENT' or job.lease_owner is distinct from private.effective_user_id() or job.lease_token is distinct from p_lease or job.lease_until<=now() then raise exception 'LEASE_CONFLICT';end if;
  select * into profile from public.restaurant_profile where id;
  return jsonb_build_object('job_id',job.id,'device_id',device.id,'lease_id',job.lease_token,'expires_at',least(job.lease_until,now()+interval '2 minutes'),
    'bridge_url',device.endpoint,'staff_url',profile.staff_base_url,'payload',job.payload);
end $$;
grant execute on function public.get_print_bridge_authorization(uuid,uuid) to authenticated;
commit;
