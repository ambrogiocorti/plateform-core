begin;
create index audit_cursor on public.audit_log(timestamp desc,id desc);
create function public.search_audit(p_venue uuid default null,p_actor uuid default null,p_resource uuid default null,p_request uuid default null,p_action text default '',p_result text default null,p_from timestamptz default null,p_to timestamptz default null,p_before_at timestamptz default null,p_before_id uuid default null,p_limit integer default 50,p_correlation uuid default null,p_role public.user_role default null,p_impersonated boolean default null,p_resource_type text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[],false);
  if p_limit is null or p_limit not between 1 and 200 or coalesce(length(p_action),0)>100 or (p_before_at is null)<>(p_before_id is null)
    or coalesce(length(p_resource_type),0)>100 or (p_from is not null and p_to is not null and p_from>p_to) then raise exception 'INVALID_FILTER'; end if;
  return (with page as (
    select * from public.audit_log a where (p_venue is null or a.venue_id=p_venue) and (p_actor is null or a.actor_user_id=p_actor)
      and (p_resource is null or a.resource_id=p_resource) and (p_request is null or a.request_id=p_request)
      and (p_correlation is null or a.correlation_id=p_correlation) and (p_role is null or a.actor_role=p_role)
      and (p_impersonated is null or (a.impersonated_by is not null)=p_impersonated) and (p_resource_type is null or a.resource_type=p_resource_type)
      and (coalesce(p_action,'')='' or strpos(lower(a.action),lower(p_action))>0) and (p_result is null or a.result=p_result)
      and (p_from is null or a.timestamp>=p_from) and (p_to is null or a.timestamp<=p_to)
      and (p_before_at is null or (a.timestamp,a.id)<(p_before_at,p_before_id)) order by a.timestamp desc,a.id desc limit p_limit+1
  ) select jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(item) order by item.timestamp desc,item.id desc) from (select * from page order by timestamp desc,id desc limit p_limit) item),'[]'),
    'has_more',(select count(*)>p_limit from page)));
end $$;
grant execute on function public.search_audit(uuid,uuid,uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,uuid,integer,uuid,public.user_role,boolean,text) to authenticated;
commit;
