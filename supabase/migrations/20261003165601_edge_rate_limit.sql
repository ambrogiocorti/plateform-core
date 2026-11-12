begin;
create function public.consume_edge_rate_limit(p_bucket text,p_limit integer,p_seconds integer) returns boolean language plpgsql security definer set search_path='' as $$
begin
  if length(p_bucket)>200 or p_limit not between 1 and 1000 or p_seconds not between 1 and 86400 then raise exception 'INVALID_RATE_LIMIT'; end if;
  return private.check_rate_limit(p_bucket,p_limit,p_seconds);
end $$;
grant execute on function public.consume_edge_rate_limit(text,integer,integer) to service_role;
commit;
