begin;
create table public.asset_uploads (
  id uuid primary key default gen_random_uuid(),actor_id uuid not null references public.staff_profiles(id),bucket text not null check(bucket in ('branding','dishes','gallery','documents')),
  venue_id uuid references public.venues(id),resource_id uuid,path text not null,size_bytes bigint not null check(size_bytes between 1 and 5242880),mime text not null,
  status text not null default 'RESERVED' check(status in ('RESERVED','SAVED','FAILED','DELETED')),checksum text,created_at timestamptz not null default now(),saved_at timestamptz,
  unique(bucket,path)
);
alter table public.asset_uploads enable row level security;
revoke all on public.asset_uploads from public,anon,authenticated;
grant select on public.asset_uploads to authenticated;
create policy authorized_read on public.asset_uploads for select to authenticated using(private.current_role()='ADMIN' and ((venue_id is null and private.current_scope()='CHAIN') or private.has_venue(venue_id)));
create function public.reserve_asset_upload(p_bucket text,p_resource uuid,p_venue uuid,p_size bigint,p_mime text) returns jsonb language plpgsql security definer set search_path='' as $$
declare ref uuid:=gen_random_uuid();path text;suffix text;
begin perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if p_venue is null and private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED';end if;
  if p_bucket is null or p_bucket not in ('branding','dishes','gallery','documents') or p_size is null or p_size not between 1 and 5242880 or p_mime is null or
    (p_bucket<>'documents' and p_mime not in ('image/png','image/jpeg','image/webp')) or (p_bucket='documents' and p_mime<>'application/pdf') then raise exception 'INVALID_ASSET';end if;
  if p_bucket in ('branding','dishes') and p_venue is not null then raise exception 'CHAIN_RESOURCE_REQUIRED';end if;
  if p_bucket='dishes' and not exists(select 1 from public.dishes where id=p_resource and active) then raise exception 'NOT_FOUND';end if;
  perform 1 from public.system_limits where id for update;
  if (select coalesce(sum(size_bytes),0) from public.asset_uploads where status in ('RESERVED','SAVED'))+p_size>(select max_storage_bytes from public.system_limits where id) then raise exception 'STORAGE_LIMIT';end if;
  suffix:=case p_mime when 'image/png' then '.png' when 'image/jpeg' then '.jpg' when 'image/webp' then '.webp' else '.pdf' end;
  path:=coalesce(p_venue::text,'global')||'/'||coalesce(p_resource::text,'brand')||'/'||ref::text||suffix;
  insert into public.asset_uploads(id,actor_id,bucket,venue_id,resource_id,path,size_bytes,mime) values(ref,private.effective_user_id(),p_bucket,p_venue,p_resource,path,p_size,p_mime);
  return jsonb_build_object('id',ref,'path',path);
end $$;
grant execute on function public.reserve_asset_upload(text,uuid,uuid,bigint,text) to authenticated;
create function public.finish_asset_upload(p_id uuid,p_success boolean,p_checksum text) returns void language plpgsql security definer set search_path='' as $$
declare upload public.asset_uploads;
begin select * into upload from public.asset_uploads where id=p_id for update;if upload.id is null then raise exception 'NOT_FOUND';end if;
  if upload.status<>'RESERVED' then return;end if;
  if p_success is null or (p_success and (p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$')) then raise exception 'INVALID_ASSET';end if;
  update public.asset_uploads set status=case when p_success then 'SAVED' else 'FAILED' end,checksum=p_checksum,saved_at=case when p_success then now() end where id=upload.id;
  perform private.audit('ASSET_UPLOAD_RESULT','asset_uploads',upload.id,upload.venue_id,null,jsonb_build_object('status',case when p_success then 'SAVED' else 'FAILED' end));
end $$;
grant execute on function public.finish_asset_upload(uuid,boolean,text) to service_role;
-- Keep buckets deployment-owned; browsers upload only through the validated Edge boundary.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
  ('branding','branding',true,5242880,array['image/png','image/jpeg','image/webp']),('dishes','dishes',true,5242880,array['image/png','image/jpeg','image/webp']),
  ('gallery','gallery',true,5242880,array['image/png','image/jpeg','image/webp']),('documents','documents',false,5242880,array['application/pdf'])
  on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy plateform_public_assets on storage.objects for select to anon,authenticated using(bucket_id in ('branding','dishes','gallery'));
create policy plateform_private_documents on storage.objects for select to authenticated using(bucket_id='documents' and exists(select 1 from public.asset_uploads a where a.bucket=bucket_id and a.path=name and a.status='SAVED'));

create function public.save_brand_content(p_version bigint,p_branding jsonb,p_content jsonb,p_contact jsonb,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare profile public.restaurant_profile;result jsonb;
begin perform private.authorize(null,array['ADMIN']::public.user_role[]);if private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED';end if;
  result:=private.idempotency_begin('brand_content',p_key,jsonb_build_object('version',p_version,'branding',p_branding,'content',p_content,'contact',p_contact));if result is not null then return result;end if;
  select * into profile from public.restaurant_profile where id for update;if profile.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if p_branding is null or p_content is null or p_contact is null or jsonb_typeof(p_branding)<>'object' or jsonb_typeof(p_content)<>'object' or jsonb_typeof(p_contact)<>'object' or pg_column_size(p_branding||p_content||p_contact)>262144 then raise exception 'INVALID_CONTENT';end if;
  if p_branding-array['logo_url','accent_color','background_color']<>'{}' or p_content-array['hero_image','hero_title','hero_subtitle','story_title','story','gallery','privacy_url','booking_note']<>'{}' or p_contact-array['instagram','facebook','email','phone']<>'{}' then raise exception 'INVALID_CONTENT';end if;
  if (p_branding ? 'accent_color' and p_branding->>'accent_color' !~ '^#[0-9a-fA-F]{6}$') or (p_branding ? 'background_color' and p_branding->>'background_color' !~ '^#[0-9a-fA-F]{6}$') then raise exception 'INVALID_CONTENT';end if;
  if exists(select 1 from jsonb_each_text(p_branding) where key='logo_url' and value<>'' and value !~ '^https://') or exists(select 1 from jsonb_each_text(p_content) where key in ('hero_image','privacy_url') and value<>'' and value !~ '^https://') then raise exception 'INVALID_ASSET_URL';end if;
  update public.restaurant_profile set branding=p_branding,public_content=p_content,contact=p_contact where id returning * into profile;
  perform private.audit('PUBLIC_CONTENT_CHANGED','restaurant_profile',null,null,null,jsonb_build_object('version',profile.version));
  return private.idempotency_finish('brand_content',p_key,jsonb_build_object('version',profile.version));
end $$;
grant execute on function public.save_brand_content(bigint,jsonb,jsonb,jsonb,uuid) to authenticated;
create function public.save_venue_details(p_venue uuid,p_version bigint,p_values jsonb,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.venues;result jsonb;k text;
begin perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('venue_details',p_key,jsonb_build_object('venue',p_venue,'version',p_version,'values',p_values));if result is not null then return result;end if;
  select * into v from public.venues where id=p_venue for update;if v.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if p_values is null or p_values-array['name','address','phone','email','opening_hours','operational_status']<>'{}' or jsonb_typeof(p_values)<>'object' or pg_column_size(p_values)>32768 then raise exception 'INVALID_SETTINGS';end if;
  for k in select jsonb_object_keys(p_values) loop execute format('update public.venues v set %I=r.%I from jsonb_populate_record(null::public.venues,$1) r where v.id=$2',k,k) using p_values,p_venue;end loop;
  return private.idempotency_finish('venue_details',p_key,jsonb_build_object('id',v.id));
end $$;
grant execute on function public.save_venue_details(uuid,bigint,jsonb,uuid) to authenticated;
create function public.save_operational_settings(p_venue uuid,p_version bigint,p_values jsonb,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('operational_settings',p_key,jsonb_build_object('venue',p_venue,'version',p_version,'values',p_values));if result is not null then return result;end if;
  perform 1 from public.venue_settings where venue_id=p_venue and version=p_version for update;if not found then raise exception 'VERSION_CONFLICT';end if;
  perform public.configure_venue_operations(p_venue,p_values);return private.idempotency_finish('operational_settings',p_key,jsonb_build_object('id',p_venue));
end $$;
grant execute on function public.save_operational_settings(uuid,bigint,jsonb,uuid) to authenticated;
commit;
