
do $patch$
declare
  src text;
  old_branch text := $old$
    if ((p_date+make_interval(mins=>v_minute)) at time zone v_venue.timezone)<=clock_timestamp() then
      v_available:=false;
      v_reason:='BOOKING_IN_PAST';
$old$;
  new_branch text := $new$
    -- A local clock time skipped by DST must never be advertised as bookable.
    -- Round-trip the local timestamp through the venue timezone, matching
    -- create_public_reservation's NONEXISTENT_LOCAL_TIME validation.
    if (((p_date + make_interval(mins=>v_minute)) at time zone v_venue.timezone)
        at time zone v_venue.timezone)
          <> (p_date + make_interval(mins=>v_minute)) then
      v_available:=false;
      v_reason:='NONEXISTENT_LOCAL_TIME';
    elsif ((p_date+make_interval(mins=>v_minute)) at time zone v_venue.timezone)<=clock_timestamp() then
      v_available:=false;
      v_reason:='BOOKING_IN_PAST';
$new$;
begin
  src := pg_get_functiondef('public.get_public_booking_availability(uuid,uuid,date,integer)'::regprocedure);
  if src is null or position(old_branch in src)=0 or position('NONEXISTENT_LOCAL_TIME' in src)>0 then
    raise exception 'STEP11_DST_FUNCTION_SIGNATURE_CHANGED';
  end if;
  execute replace(src,old_branch,new_branch);
end
$patch$;
comment on function public.get_public_booking_availability(uuid,uuid,date,integer) is
'Public availability respects per-venue capacity, deposit and timezone DST gap validation. Nonexistent local clock times return available=false and reason NONEXISTENT_LOCAL_TIME.';
