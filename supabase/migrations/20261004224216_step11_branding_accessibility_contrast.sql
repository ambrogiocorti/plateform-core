create or replace function private.brand_color_luminance(p_hex text)
returns double precision
language plpgsql
immutable strict
set search_path=''
as $$
declare r double precision; g double precision; b double precision;
begin
  if p_hex !~ '^#[0-9a-fA-F]{6}$' then return null; end if;
  r := (('x'||substring(p_hex from 2 for 2))::bit(8)::int) / 255.0;
  g := (('x'||substring(p_hex from 4 for 2))::bit(8)::int) / 255.0;
  b := (('x'||substring(p_hex from 6 for 2))::bit(8)::int) / 255.0;
  r := case when r <= 0.04045 then r / 12.92 else power((r + 0.055) / 1.055, 2.4) end;
  g := case when g <= 0.04045 then g / 12.92 else power((g + 0.055) / 1.055, 2.4) end;
  b := case when b <= 0.04045 then b / 12.92 else power((b + 0.055) / 1.055, 2.4) end;
  return 0.2126*r + 0.7152*g + 0.0722*b;
end $$;

create or replace function private.brand_contrast_ratio(p_first text,p_second text)
returns double precision
language sql
immutable strict
set search_path=''
as $$
  select (greatest(private.brand_color_luminance(p_first),private.brand_color_luminance(p_second))+0.05)
       / (least(private.brand_color_luminance(p_first),private.brand_color_luminance(p_second))+0.05)
$$;

create or replace function private.branding_contrast_valid(p_branding jsonb)
returns boolean
language plpgsql
immutable strict
set search_path=''
as $$
declare
  dark_mode boolean;
  background text;
  accent text;
  preferred_text text;
begin
  if jsonb_typeof(p_branding) <> 'object' then return false; end if;
  if (p_branding ? 'background_color' and coalesce(p_branding->>'background_color','') !~ '^#[0-9a-fA-F]{6}$')
     or (p_branding ? 'accent_color' and coalesce(p_branding->>'accent_color','') !~ '^#[0-9a-fA-F]{6}$')
     or (p_branding ? 'dark_mode' and jsonb_typeof(p_branding->'dark_mode') <> 'boolean') then
    return false;
  end if;
  dark_mode := case when p_branding ? 'dark_mode' then (p_branding->>'dark_mode')::boolean else true end;
  background := coalesce(nullif(p_branding->>'background_color',''), case when dark_mode then '#111315' else '#f4f0e8' end);
  accent := coalesce(nullif(p_branding->>'accent_color',''), '#b88a55');
  preferred_text := case when dark_mode then '#f4f0e8' else '#181b1d' end;
  return private.brand_contrast_ratio(background,preferred_text) >= 4.5
     and private.brand_contrast_ratio(accent,background) >= 4.5;
exception when others then
  return false;
end $$;

revoke all on function private.brand_color_luminance(text) from public,anon,authenticated;
revoke all on function private.brand_contrast_ratio(text,text) from public,anon,authenticated;
revoke all on function private.branding_contrast_valid(jsonb) from public,anon,authenticated;

alter table public.restaurant_profile
  drop constraint if exists restaurant_profile_branding_contrast_check;
alter table public.restaurant_profile
  add constraint restaurant_profile_branding_contrast_check
  check (private.branding_contrast_valid(branding));