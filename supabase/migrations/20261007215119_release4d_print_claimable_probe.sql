
create or replace function private.test_print_claimable_jobs()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='d05b9ce5-1049-4622-bb49-35ebef2c777a'::uuid;
  v_session constant uuid:='15e44a65-d47e-42f8-a5bf-77dd13c6540e'::uuid;
  v_venue constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_epos uuid:=gen_random_uuid();
  v_bridge uuid:=gen_random_uuid();
  v_browser uuid:=gen_random_uuid();
  v_cashier_only uuid:=gen_random_uuid();
  v_job_epos uuid:=gen_random_uuid();
  v_job_bridge uuid:=gen_random_uuid();
  v_job_browser uuid:=gen_random_uuid();
  v_job_cashier uuid:=gen_random_uuid();
  v_result jsonb;
  v_detail text;
  v_evidence jsonb;
begin
  begin
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub',v_user::text,
        'session_id',v_session::text,
        'iat',extract(epoch from clock_timestamp())::bigint,
        'aal','aal2','role','authenticated',
        'amr',jsonb_build_array(jsonb_build_object(
          'method','password',
          'timestamp',extract(epoch from clock_timestamp())::bigint
        ))
      )::text,
      true
    );
    perform set_config('request.headers','{}',true);

    update private.staff_sessions
    set unlocked_until=clock_timestamp()+interval '30 minutes'
    where session_id=v_session and user_id=v_user and revoked_at is null;

    insert into public.staff_venue_assignments(user_id,venue_id,active)
    values(v_user,v_venue,true)
    on conflict(user_id,venue_id) do update set active=true;

    insert into public.print_devices(id,venue_id,name,driver,endpoint,active,allowed_roles)
    values
      (v_epos,v_venue,'E2E EPOS','EPOS','https://printer.example.test/epos',true,array['ADMIN']::public.user_role[]),
      (v_bridge,v_venue,'E2E BRIDGE','BRIDGE','http://127.0.0.1:9100/print',true,array['ADMIN']::public.user_role[]),
      (v_browser,v_venue,'E2E BROWSER','BROWSER',null,true,array['ADMIN']::public.user_role[]),
      (v_cashier_only,v_venue,'E2E CASHIER','EPOS','https://printer.example.test/cashier',true,array['CASHIER']::public.user_role[]);

    insert into public.print_jobs(id,venue_id,print_device_id,kind,payload,requested_by,idempotency_key)
    values
      (v_job_epos,v_venue,v_epos,'KITCHEN','{}'::jsonb,v_user,gen_random_uuid()),
      (v_job_bridge,v_venue,v_bridge,'KITCHEN','{}'::jsonb,v_user,gen_random_uuid()),
      (v_job_browser,v_venue,v_browser,'COURTESY','{}'::jsonb,v_user,gen_random_uuid()),
      (v_job_cashier,v_venue,v_cashier_only,'RECEIPT','{}'::jsonb,v_user,gen_random_uuid());

    v_result:=public.get_claimable_print_jobs(v_venue,10);

    if jsonb_array_length(v_result)<>2
       or not exists(select 1 from jsonb_array_elements(v_result) x where (x->>'id')::uuid=v_job_epos and x->>'driver'='EPOS')
       or not exists(select 1 from jsonb_array_elements(v_result) x where (x->>'id')::uuid=v_job_bridge and x->>'driver'='BRIDGE')
       or exists(select 1 from jsonb_array_elements(v_result) x where (x->>'id')::uuid=v_job_browser)
       or exists(select 1 from jsonb_array_elements(v_result) x where (x->>'id')::uuid=v_job_cashier)
    then
      raise exception 'PRINT_CLAIMABLE_FILTER_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'claimable_count',jsonb_array_length(v_result),
      'epos_visible',true,
      'bridge_visible',true,
      'browser_background_hidden',true,
      'role_forbidden_hidden',true,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_PRINT_CLAIMABLE_TEST__' using detail=v_evidence::text;
  exception when others then
    get stacked diagnostics v_detail=pg_exception_detail;
    if sqlerrm='__ROLLBACK_PRINT_CLAIMABLE_TEST__' then return v_detail::jsonb; end if;
    raise;
  end;
end
$$;

revoke all on function private.test_print_claimable_jobs()
from public,anon,authenticated;
grant execute on function private.test_print_claimable_jobs()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'PRINT_CLAIMABLE_QUEUE_AUTHORIZATION',
  'REGRESSION',
  true,
  'Automatic staff print consumer only sees queued EPOS/BRIDGE jobs for active devices allowed to the current role; BROWSER jobs remain manual and role-forbidden devices are hidden.'
)
on conflict(key) do nothing;
