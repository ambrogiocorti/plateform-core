
create or replace function private.classify_menu_engineering(
  p_popularity numeric,
  p_margin numeric,
  p_popularity_threshold numeric,
  p_margin_threshold numeric
)
returns text
language plpgsql
immutable
set search_path=''
as $$
begin
  if p_popularity is null
     or p_margin is null
     or p_popularity_threshold is null
     or p_margin_threshold is null
  then
    return 'UNCLASSIFIED';
  end if;

  if p_popularity>=p_popularity_threshold
     and p_margin>=p_margin_threshold then
    return 'STAR';
  elsif p_popularity>=p_popularity_threshold
     and p_margin<p_margin_threshold then
    return 'PLOWHORSE';
  elsif p_popularity<p_popularity_threshold
     and p_margin>=p_margin_threshold then
    return 'PUZZLE';
  else
    return 'DOG';
  end if;
end
$$;

revoke all on function private.classify_menu_engineering(numeric,numeric,numeric,numeric)
from public,anon,authenticated;
