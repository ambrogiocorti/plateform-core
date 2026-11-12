-- Step 11: the four publicly rendered RPCs are intentional Data API reads.
-- Record the already-tested grants without changing permissions.
do $check$
declare
  v_missing integer;
begin
  with expected(identity) as (
    values
      ('public.get_public_menu_index(uuid)'::text),
      ('public.get_public_navigation(uuid)'::text),
      ('public.get_public_page_metadata(text,uuid)'::text),
      ('public.get_public_sitemap_entries()'::text)
  )
  select count(*)::integer into v_missing
  from expected e
  left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.identity)
  where p.oid is null
     or p.prosecdef is not true
     or p.proconfig is null
     or not exists(select 1 from pg_catalog.unnest(p.proconfig) c where c in ('search_path=""','search_path='));
  if v_missing<>0 then raise exception 'PUBLIC_RPC_SECURITY_CONTRACT_CHANGED'; end if;
end
$check$;

insert into private.api_permission_manifest(function_identity,api_role)
select e.identity, r.api_role
from (values
  ('public.get_public_menu_index(uuid)'::text),
  ('public.get_public_navigation(uuid)'::text),
  ('public.get_public_page_metadata(text,uuid)'::text),
  ('public.get_public_sitemap_entries()'::text)
) e(identity)
cross join (values ('anon'::text),('authenticated'::text)) r(api_role)
where has_function_privilege(r.api_role,pg_catalog.to_regprocedure(e.identity),'EXECUTE')
on conflict do nothing;

do $verify$
begin
  if (private.api_permission_manifest_report()->>'ok')::boolean is distinct from true
    then raise exception 'API_PERMISSION_MANIFEST_NOT_ALIGNED';
  end if;
end
$verify$;