begin;
drop policy if exists owner_read on public.staff_admin_jobs;
create policy owner_read on public.staff_admin_jobs
  for select to authenticated
  using (
    actor_id = (select auth.uid())
    and private.is_role(array['ADMIN','SUPER_ADMIN']::public.user_role[])
  );
commit;