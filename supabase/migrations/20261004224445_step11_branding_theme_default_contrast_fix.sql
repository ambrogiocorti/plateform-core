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
  accent := coalesce(nullif(p_branding->>'accent_color',''), case when dark_mode then '#d3ab78' else '#795127' end);
  preferred_text := case when dark_mode then '#f4f0e8' else '#181b1d' end;
  return private.brand_contrast_ratio(background,preferred_text) >= 4.5
     and private.brand_contrast_ratio(accent,background) >= 4.5;
exception when others then
  return false;
end $$;

revoke all on function private.branding_contrast_valid(jsonb) from public,anon,authenticated;