
create or replace function private.critical_client_write_privilege_report()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  with critical(relname) as (
    values
      ('staff_profiles'),('feature_flags'),('venue_dish_settings'),('dishes'),
      ('accounts'),('orders'),('order_items'),('payments'),('refunds'),
      ('billing_units'),('cash_journal'),('audit_log'),('backup_metadata'),('restore_jobs')
  ),
  rels as (
    select c.oid,c.relname,
           coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner)) acl
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    join critical x on x.relname=c.relname
    where n.nspname='public'
      and c.relkind in ('r','p')
  ),
  violations as (
    select r.relname,
           case when a.grantee=0 then 'PUBLIC' else pr.rolname end as grantee,
           a.privilege_type
    from rels r
    join lateral pg_catalog.aclexplode(r.acl) a on true
    left join pg_catalog.pg_roles pr on pr.oid=a.grantee
    where a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
      and (
        a.grantee=0
        or pr.rolname in ('anon','authenticated')
      )
  )
  select jsonb_build_object(
    'ok',not exists(select 1 from violations),
    'violations',coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'table',relname,
            'grantee',grantee,
            'privilege',privilege_type
          )
          order by relname,grantee,privilege_type
        )
        from violations
      ),
      '[]'::jsonb
    )
  )
$$;

revoke all on function private.critical_client_write_privilege_report()
from public,anon,authenticated;
