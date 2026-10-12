begin;
-- Upload reservations survive lost Edge responses without charging storage twice.
create function public.reserve_asset_upload_command(p_bucket text,p_resource uuid,p_venue uuid,p_size bigint,p_mime text,p_checksum text,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_ASSET';end if;
  result:=private.idempotency_begin('asset_upload',p_key,jsonb_build_object('bucket',p_bucket,'resource',p_resource,'venue',p_venue,'size',p_size,'mime',p_mime,'checksum',p_checksum));
  if result is not null then return result;end if;
  result:=public.reserve_asset_upload(p_bucket,p_resource,p_venue,p_size,p_mime);
  return private.idempotency_finish('asset_upload',p_key,result);
end $$;
grant execute on function public.reserve_asset_upload_command(text,uuid,uuid,bigint,text,text,uuid) to authenticated;

-- Every resource lookup runs under the caller's RLS, including assistance scope.
create function public.search_operational_resources(p_query text,p_venue uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare pattern text;result jsonb;
begin
  if p_query is null or length(trim(p_query)) not between 2 and 100 then return '[]'::jsonb;end if;
  pattern:='%'||replace(replace(replace(trim(p_query),'\','\\'),'%','\%'),'_','\_')||'%';
  select coalesce(jsonb_agg(to_jsonb(hit) order by hit.kind,hit.label),'[]') into result from (
    (select 'TABLE'::text kind,t.id,t.name label,'/sala?tavolo='||t.id::text path,t.venue_id
      from public.tables t where t.active and (p_venue is null or t.venue_id=p_venue) and (t.name ilike pattern or t.number::text ilike pattern) limit 10)
    union all
    (select 'ACCOUNT',a.id,a.account_name,'/conti/'||a.id::text,a.venue_id from public.accounts a
      where (p_venue is null or a.venue_id=p_venue) and a.account_name ilike pattern order by a.created_at desc limit 10)
    union all
    (select 'RESERVATION',r.id,r.first_name||coalesce(' '||r.last_name,''),'/accoglienza?prenotazione='||r.id::text,r.venue_id
      from public.reservations r where (p_venue is null or r.venue_id=p_venue) and (r.first_name||coalesce(' '||r.last_name,'') ilike pattern or r.phone ilike pattern)
      order by r.service_date desc limit 10)
    union all
    (select 'DISH',d.id,d.name,'/gestione?modulo=dishes&elemento='||d.id::text,null::uuid from public.dishes d
      where d.active and d.name ilike pattern order by d.name limit 10)
    union all
    (select 'STAFF',s.id,s.display_name,'/staff?utente='||s.id::text,null::uuid from public.staff_profiles s
      where s.active and s.display_name ilike pattern order by s.display_name limit 10)
    union all
    (select 'REGISTER',c.id,c.name,'/cassa?postazione='||c.id::text,c.venue_id from public.cash_registers c
      where c.active and (p_venue is null or c.venue_id=p_venue) and (c.name ilike pattern or c.code ilike pattern) order by c.name limit 10)
    union all
    (select 'VENUE',v.id,v.name,'/sala?sede='||v.id::text,v.id from public.venues v
      where v.active and (p_venue is null or v.id=p_venue) and v.name ilike pattern order by v.name limit 10)
  ) hit;
  return result;
end $$;
grant execute on function public.search_operational_resources(text,uuid) to authenticated;
commit;
