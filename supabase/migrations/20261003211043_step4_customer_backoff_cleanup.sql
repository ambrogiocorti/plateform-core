begin;

create or replace function public.record_customer_access_failure(p_bucket text) returns integer
language plpgsql security definer set search_path='' as $$
declare count_now integer; seconds integer;
begin
  if p_bucket is null or p_bucket !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_RATE_BUCKET'; end if;

  delete from private.customer_access_backoff
  where bucket in (
    select bucket
    from private.customer_access_backoff
    where last_attempt_at < clock_timestamp()-interval '1 day'
      and coalesce(blocked_until,'-infinity'::timestamptz) < clock_timestamp()
      and bucket<>p_bucket
    order by last_attempt_at
    limit 100
  );

  insert into private.customer_access_backoff(bucket,failures,blocked_until,last_attempt_at)
  values(p_bucket,1,null,clock_timestamp())
  on conflict(bucket) do update set
    failures=case when private.customer_access_backoff.last_attempt_at<clock_timestamp()-interval '15 minutes'
      then 1 else least(private.customer_access_backoff.failures+1,1000) end,
    last_attempt_at=clock_timestamp(),
    blocked_until=null
  returning failures into count_now;

  seconds:=case when count_now<=3 then 0 else least(900,(power(2,least(count_now-3,10)))::integer) end;
  if seconds>0 then
    update private.customer_access_backoff
       set blocked_until=clock_timestamp()+make_interval(secs=>seconds)
     where bucket=p_bucket;
  end if;
  return seconds;
end $$;

commit;