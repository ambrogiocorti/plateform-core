
do $$
declare
  r record;
begin
  for r in
    select function_identity,api_role
    from private.api_permission_manifest
    where api_role in ('anon','authenticated')
  loop
    begin
      perform to_regprocedure(r.function_identity);
    exception when others then
      delete from private.api_permission_manifest
      where function_identity=r.function_identity
        and api_role=r.api_role;
    end;
  end loop;
end
$$;
