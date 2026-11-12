begin;
create function private.staff_has_venue(p_user uuid,p_venue uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.staff_profiles p where p.id=p_user and p.active and (p.scope='CHAIN' or
   exists(select 1 from public.staff_venue_assignments a where a.user_id=p.id and a.venue_id=p_venue and a.active)))
$$;
create function public.assign_operational_staff(p_venue uuid,p_user uuid,p_kind text,p_resource uuid,p_active boolean default true) returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if not private.staff_has_venue(p_user,p_venue) then raise exception 'STAFF_VENUE_FORBIDDEN'; end if;
  if p_kind='STATION' then
    if not exists(select 1 from public.staff_profiles where id=p_user and role='KITCHEN_STAFF') then raise exception 'KITCHEN_STAFF_REQUIRED'; end if;
    insert into public.station_staff_assignments(venue_id,station_id,user_id,active) values(p_venue,p_resource,p_user,p_active)
      on conflict(station_id,user_id) do update set active=excluded.active;
  elsif p_kind='REGISTER' then
    if not exists(select 1 from public.staff_profiles where id=p_user and role='CASHIER') then raise exception 'CASHIER_REQUIRED'; end if;
    insert into public.cashier_assignments(venue_id,cash_register_id,user_id,active) values(p_venue,p_resource,p_user,p_active)
      on conflict(cash_register_id,user_id) do update set active=excluded.active;
  else raise exception 'INVALID_ASSIGNMENT_KIND'; end if;
end $$;
grant execute on function public.assign_operational_staff(uuid,uuid,text,uuid,boolean) to authenticated;

create function private.can_manage_staff(p_user uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.staff_profiles target where target.id=p_user and target.role<>'SUPER_ADMIN' and target.id<>auth.uid()
   and ((private.current_role()='SUPER_ADMIN' and target.role='ADMIN') or
     (private.current_role()='ADMIN' and target.role<>'ADMIN' and (private.current_scope()='CHAIN' or
       (target.scope='VENUE' and exists(select 1 from public.staff_venue_assignments a where a.user_id=target.id and a.active)
         and not exists(select 1 from public.staff_venue_assignments a where a.user_id=target.id and a.active and not private.has_venue(a.venue_id)))))))
$$;
create function public.revoke_staff_for_reset(p_user uuid,p_step_up uuid,p_disable boolean default false) returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  if not private.can_manage_staff(p_user) then raise exception 'STAFF_MANAGEMENT_FORBIDDEN' using errcode='42501'; end if;
  perform private.consume_step_up(p_step_up,case when private.current_role()='SUPER_ADMIN' then 'PRIVILEGED_STAFF' else 'STAFF_CHANGE' end,p_user);
  update public.staff_profiles set auth_valid_after=now(),active=not p_disable where id=p_user;
  update private.staff_sessions set revoked_at=now() where user_id=p_user;
  update public.registered_devices set revoked_at=now() where user_id=p_user and revoked_at is null;
  update public.offline_authorization_snapshots set revoked_at=now() where user_id=p_user;
  delete from private.staff_pins where user_id=p_user;
  perform private.audit(case when p_disable then 'STAFF_DISABLED' else 'STAFF_PASSWORD_RESET_AUTHORIZED' end,'staff_profiles',p_user,null);
end $$;
grant execute on function public.revoke_staff_for_reset(uuid,uuid,boolean) to authenticated;
commit;
