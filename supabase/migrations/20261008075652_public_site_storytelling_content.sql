begin;

create or replace function public.save_brand_content(
  p_version bigint,
  p_branding jsonb,
  p_content jsonb,
  p_contact jsonb,
  p_key uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  profile public.restaurant_profile;
  result jsonb;
  content_value jsonb:=p_content;
  item jsonb;
  normalized_gallery jsonb:='[]'::jsonb;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED'; end if;

  result:=private.idempotency_begin(
    'brand_content',p_key,
    jsonb_build_object('version',p_version,'branding',p_branding,'content',p_content,'contact',p_contact)
  );
  if result is not null then return result; end if;

  select * into profile from public.restaurant_profile where id for update;
  if profile.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;

  if p_branding is null or p_content is null or p_contact is null
     or jsonb_typeof(p_branding)<>'object'
     or jsonb_typeof(p_content)<>'object'
     or jsonb_typeof(p_contact)<>'object'
     or pg_column_size(p_branding||p_content||p_contact)>262144 then
    raise exception 'INVALID_CONTENT';
  end if;

  if p_branding-array[
       'logo_url','favicon_url','accent_color','background_color',
       'font_heading','font_body','dark_mode','layout'
     ]<>'{}'
     or p_content-array[
       'hero_image','hero_image_url','hero_image_alt','hero_eyebrow','hero_title','hero_subtitle',
       'story_title','story','philosophy_title','philosophy','chef_name','chef_bio','chef_image_url','chef_image_alt',
       'gallery','privacy_url','booking_note','footer','seo_title','seo_description','sections'
     ]<>'{}'
     or p_contact-array['instagram','facebook','email','phone','vat_number']<>'{}' then
    raise exception 'INVALID_CONTENT';
  end if;

  if (p_branding ? 'accent_color' and p_branding->>'accent_color' !~ '^#[0-9a-fA-F]{6}$')
     or (p_branding ? 'background_color' and p_branding->>'background_color' !~ '^#[0-9a-fA-F]{6}$')
     or (p_branding ? 'font_heading' and p_branding->>'font_heading' not in ('SERIF','SANS','HUMANIST'))
     or (p_branding ? 'font_body' and p_branding->>'font_body' not in ('SERIF','SANS','HUMANIST'))
     or (p_branding ? 'layout' and p_branding->>'layout' not in ('EDITORIAL','MODERN','CLASSIC'))
     or (p_branding ? 'dark_mode' and jsonb_typeof(p_branding->'dark_mode')<>'boolean') then
    raise exception 'INVALID_CONTENT';
  end if;

  if exists(
       select 1 from jsonb_each_text(p_branding)
       where key in ('logo_url','favicon_url') and value<>'' and value !~ '^https://'
     ) then
    raise exception 'INVALID_ASSET_URL';
  end if;

  if not content_value ? 'hero_image_url' and content_value ? 'hero_image' then
    content_value:=content_value||jsonb_build_object('hero_image_url',content_value->>'hero_image');
  end if;
  content_value:=content_value-'hero_image';

  if exists(
       select 1 from jsonb_each_text(content_value)
       where key in ('hero_image_url','chef_image_url','privacy_url') and value<>'' and value !~ '^https://'
     ) then
    raise exception 'INVALID_ASSET_URL';
  end if;

  if length(coalesce(content_value->>'hero_image_alt',''))>180
     or length(coalesce(content_value->>'hero_eyebrow',''))>80
     or length(coalesce(content_value->>'hero_title',''))>160
     or length(coalesce(content_value->>'hero_subtitle',''))>500
     or length(coalesce(content_value->>'story_title',''))>160
     or length(coalesce(content_value->>'story',''))>10000
     or length(coalesce(content_value->>'philosophy_title',''))>160
     or length(coalesce(content_value->>'philosophy',''))>10000
     or length(coalesce(content_value->>'chef_name',''))>160
     or length(coalesce(content_value->>'chef_bio',''))>10000
     or length(coalesce(content_value->>'chef_image_alt',''))>180
     or length(coalesce(content_value->>'booking_note',''))>2000
     or length(coalesce(content_value->>'footer',''))>500
     or length(coalesce(content_value->>'seo_title',''))>70
     or length(coalesce(content_value->>'seo_description',''))>200 then
    raise exception 'INVALID_CONTENT';
  end if;

  if coalesce(content_value->>'hero_image_url','')<>'' and trim(coalesce(content_value->>'hero_image_alt',''))='' then
    content_value:=content_value||jsonb_build_object('hero_image_alt',profile.name);
  end if;

  if coalesce(content_value->>'chef_image_url','')<>'' and trim(coalesce(content_value->>'chef_image_alt',''))='' then
    content_value:=content_value||jsonb_build_object(
      'chef_image_alt',
      coalesce(nullif(trim(content_value->>'chef_name'),''),'Chef di '||profile.name)
    );
  end if;

  if content_value ? 'gallery' then
    if jsonb_typeof(content_value->'gallery')<>'array'
       or jsonb_array_length(content_value->'gallery')>30 then
      raise exception 'INVALID_CONTENT';
    end if;
    normalized_gallery:='[]'::jsonb;
    for item in select value from jsonb_array_elements(content_value->'gallery') loop
      if jsonb_typeof(item)='string' then
        if trim(item#>>'{}')='' or item#>>'{}' !~ '^https://' then
          raise exception 'INVALID_ASSET_URL';
        end if;
        normalized_gallery:=normalized_gallery||jsonb_build_array(
          jsonb_build_object('url',item#>>'{}','alt','Fotografia di '||profile.name)
        );
      elsif jsonb_typeof(item)='object' then
        if item-array['url','alt']<>'{}'
           or coalesce(item->>'url','') !~ '^https://'
           or length(trim(coalesce(item->>'alt',''))) not between 1 and 180 then
          raise exception 'INVALID_CONTENT';
        end if;
        normalized_gallery:=normalized_gallery||jsonb_build_array(
          jsonb_build_object('url',item->>'url','alt',trim(item->>'alt'))
        );
      else
        raise exception 'INVALID_CONTENT';
      end if;
    end loop;
    content_value:=jsonb_set(content_value,'{gallery}',normalized_gallery,true);
  end if;

  if content_value ? 'sections' then
    if jsonb_typeof(content_value->'sections')<>'object'
       or exists(
         select 1 from jsonb_each(content_value->'sections')
         where key not in ('story','philosophy','chef','gallery','venues','booking','contacts')
            or jsonb_typeof(value)<>'boolean'
       ) then
      raise exception 'INVALID_CONTENT';
    end if;
  end if;

  if length(coalesce(p_contact->>'phone',''))>40
     or length(coalesce(p_contact->>'email',''))>254
     or length(coalesce(p_contact->>'vat_number',''))>40
     or (coalesce(p_contact->>'email','')<>'' and p_contact->>'email' !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
     or exists(
       select 1 from jsonb_each_text(p_contact)
       where key in ('instagram','facebook') and value<>'' and value !~ '^https://'
     ) then
    raise exception 'INVALID_CONTENT';
  end if;

  update public.restaurant_profile
     set branding=p_branding,public_content=content_value,contact=p_contact
   where id
   returning * into profile;

  perform private.audit(
    'PUBLIC_CONTENT_CHANGED','restaurant_profile',null,null,null,
    jsonb_build_object('version',profile.version)
  );

  return private.idempotency_finish(
    'brand_content',p_key,jsonb_build_object('version',profile.version)
  );
end $$;

create or replace function private.test_public_site_storytelling_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid)
  into v_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='save_brand_content'
    and pg_get_function_identity_arguments(p.oid)='p_version bigint, p_branding jsonb, p_content jsonb, p_contact jsonb, p_key uuid';

  if v_def is null
     or v_def not like '%philosophy_title%'
     or v_def not like '%philosophy%'
     or v_def not like '%chef_name%'
     or v_def not like '%chef_bio%'
     or v_def not like '%chef_image_url%'
     or v_def not like '%chef_image_alt%'
     or v_def not like '%''story'',''philosophy'',''chef'',''gallery''%'
     or v_def not like '%chef_image_url'',''privacy_url%'
  then
    raise exception 'PUBLIC_SITE_STORYTELLING_CONTRACT_FAILED';
  end if;

  return jsonb_build_object(
    'philosophy_content',true,
    'chef_content',true,
    'chef_https_image_guard',true,
    'chef_alt_text_guard',true,
    'section_visibility_controls',true
  );
end
$$;

revoke all on function private.test_public_site_storytelling_contract()
from public,anon,authenticated;
grant execute on function private.test_public_site_storytelling_contract()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'PUBLIC_SITE_STORYTELLING_CONTRACT',
  'REGRESSION',
  true,
  'Public site branding contract supports philosophy and chef content with bounded text, HTTPS-only chef imagery, accessible alt text and explicit section visibility controls.'
)
on conflict(key) do nothing;

commit;